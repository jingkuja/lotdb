import { createContext, useContext, useSyncExternalStore } from "react";
export const TabActiveContext = createContext(true);
const subscribe = (callback: () => void) => {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
};
export function useTabActive() {
  const tabActive = useContext(TabActiveContext);
  const visible = useSyncExternalStore(subscribe, () => document.visibilityState !== "hidden", () => true);
  return tabActive && visible;
}
