// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { HostClient } from "../client";

let dir: string; let child: ChildProcess; let client: HostClient;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean | Promise<boolean>, ms=15000) {
  const deadline=Date.now()+ms;
  while(!await check()) { if(Date.now()>deadline)throw new Error("Timed out waiting for isolated shell"); await pause(50); }
}
beforeAll(async()=>{
  dir=mkdtempSync(path.join(tmpdir(),"termx-directory-e2e-"));
  child=spawn(path.resolve("../target/debug/termx-host.exe"),["--data-dir",dir],{stdio:"ignore",windowsHide:true});
  let runtime:{port:number;token:string;pid:number}|undefined;
  await until(()=>{try{runtime=JSON.parse(readFileSync(path.join(dir,"runtime.json"),"utf8"));return !!runtime?.port;}catch{return false;}});
  expect(runtime!.pid).toBe(child.pid);
  client=await HostClient.connect({port:runtime!.port,token:runtime!.token,webSocketFactory:url=>new WebSocket(url)});
});
afterAll(async()=>{
  try { client?.shutdown(); await until(()=>child.exitCode!==null,10000); }
  finally {
    client?.close();
    if(child && child.exitCode===null) child.kill();
    // Only this test's verified temporary directory is eligible for removal.
    if(dir && path.dirname(path.resolve(dir))===path.resolve(tmpdir()) && path.basename(dir).startsWith("termx-directory-e2e-")) {
      await pause(200); rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:200});
    }
  }
});
it("changes the same PowerShell through the guarded transport and refuses later input",async()=>{
  const target=path.join(dir,"folder with ' & $ (1)"); mkdirSync(target,{recursive:true});
  const session=await client.createSession({profile:"powershell",cwd:dir,cols:160,rows:35});
  let output="";
  const attachment=await client.attach(session.id,{onOutput:event=>{output+=Buffer.from(event.data).toString("utf8");}});
  await until(async()=>Boolean((await client.probeSession(session.id)).at_prompt));
  const ready=await client.probeSession(session.id);
  expect(await client.changeDirectory(session.id,session.pid!,ready.prompt_id!,target)).toBe(true);
  try { await until(async()=> (await client.listSessions()).find(s=>s.id===session.id)?.cwd===target); }
  catch(error) { throw new Error(`${error}; output tail: ${JSON.stringify(output.slice(-1800))}`); }
  expect((await client.listSessions()).find(s=>s.id===session.id)?.pid).toBe(session.pid);
  await until(async()=>Boolean((await client.probeSession(session.id)).at_prompt));
  const next=await client.probeSession(session.id);
  attachment.sendInput("echo unfinished");
  expect(await client.changeDirectory(session.id,session.pid!,next.prompt_id!,dir)).toBe(false);
  await client.closeSession(session.id);
});
it("refuses an in-process PowerShell command without cancelling it",async()=>{
  const session=await client.createSession({profile:"powershell",cwd:dir,cols:160,rows:35});
  let output="";
  const attachment=await client.attach(session.id,{onOutput:e=>{output+=Buffer.from(e.data).toString("utf8");}});
  await until(async()=>Boolean((await client.probeSession(session.id)).at_prompt));
  const ready=await client.probeSession(session.id);
  attachment.sendInput("Write-Output ('TERMX'+'_BUILTIN'); Start-Sleep -Seconds 2; Write-Output ('TERMX'+'_FINISHED')\r");
  await until(()=>output.includes("TERMX_BUILTIN"));
  expect(await client.probeSession(session.id)).toMatchObject({alive:true,busy:false,at_prompt:false});
  expect(await client.changeDirectory(session.id,session.pid!,ready.prompt_id!,dir)).toBe(false);
  await until(()=>output.includes("TERMX_FINISHED"));
  expect((await client.listSessions()).find(s=>s.id===session.id)?.alive).toBe(true);
  await client.closeSession(session.id);
});
