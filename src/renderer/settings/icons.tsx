import type { ReactNode } from "react";

export type IconName = "mic" | "chart" | "book" | "scissors" | "type" | "wand" | "note" | "settings" | "search" | "plus" | "copy" | "more" | "lock";

const paths: Record<IconName, ReactNode> = {
  mic: <><rect x="8" y="3" width="8" height="11" rx="4" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" /></>,
  chart: <><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5zM20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5z" /></>,
  scissors: <><circle cx="6" cy="7" r="3" /><circle cx="6" cy="17" r="3" /><path d="m8.5 8.5 10 8.5M8.5 15.5 19 7" /></>,
  type: <><path d="M4 6V3h16v3M9 21h6M12 3v18" /></>,
  wand: <><path d="m4 20 11-11M13 5l1-3 1 3 3 1-3 1-1 3-1-3-3-1zM18 14l.8-2 .7 2 2 .7-2 .8-.7 2-.8-2-2-.8z" /></>,
  note: <><path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.15.37.36.7.66.98.3.28.69.42 1.1.42H21v4h-.09A1.7 1.7 0 0 0 19.4 15z" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
