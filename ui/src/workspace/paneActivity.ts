/** View state shared by sidebar attention and minimized-pane restore chips. */
export interface PaneActivityModel {
  activity: "idle" | "active" | "unread" | "attention";
  attentionSince: number | null;
}
