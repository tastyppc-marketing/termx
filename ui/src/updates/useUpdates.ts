import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { UpdateResult, UpdateState } from "./types";
const CHECK_INTERVAL=6*60*60*1000;
const errorMessage=(error: unknown) => typeof error === "string" ? error
  : error instanceof Error ? error.message : "The update check is unavailable";

export function useUpdates(enabled: boolean) {
  const [version,setVersion]=useState<string>();
  const [update,setUpdate]=useState<UpdateState>({kind:"idle"});
  const generation=useRef(0);
  const pending=useRef<Promise<UpdateResult> | null>(null);
  const checking=useRef<number | null>(null);
  const check=useCallback(async()=>{
    if (!enabled || checking.current===generation.current) return;
    const token=generation.current;
    checking.current=token;
    setUpdate({kind:"checking"});
    const request=pending.current ?? invoke<UpdateResult>("check_for_updates");
    pending.current=request;
    try {
      const result=await request;
      if (!result || !["current","available","no-release"].includes(result.status)) throw new Error("GitHub returned an unreadable release result");
      if (generation.current===token) setUpdate({kind:"checked",result});
    } catch(error) {
      if (generation.current===token) setUpdate({kind:"error",message:errorMessage(error)});
    } finally {
      if (pending.current===request) pending.current=null;
      if (checking.current===token) checking.current=null;
    }
  },[enabled]);
  useEffect(()=>{
    const token=++generation.current;
    if (!enabled) return;
    void getVersion().then(value=>{if(generation.current===token)setVersion(value);}).catch(()=>{});
    void check();
    const timer=setInterval(()=>void check(),CHECK_INTERVAL);
    return ()=>{generation.current++;clearInterval(timer);};
  },[enabled,check]);
  const open=useCallback(async()=>{
    if (!enabled || update.kind!=="checked" || update.result.status!=="available" || !update.result.releaseTag) return;
    const token=generation.current;
    try { await invoke("open_update_release",{tag:update.result.releaseTag}); }
    catch(error) { if(generation.current===token)setUpdate({kind:"error",message:errorMessage(error)}); }
  },[enabled,update]);
  return { version,update,check,open };
}
