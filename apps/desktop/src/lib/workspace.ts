import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { demoApi } from "@keagent/api-client";

export function useWorkspace() {
  return useQuery({
    queryKey: ["workspace"],
    queryFn: () => {
      if (
        import.meta.env.VITE_API_MODE &&
        !["mock", "live"].includes(import.meta.env.VITE_API_MODE)
      ) {
        throw new Error(
          "当前版本仅提供前端演示，请将 VITE_API_MODE 设置为 mock。",
        );
      }
      return demoApi.getWorkspace();
    },
    retry: false,
    staleTime: 15000,
  });
}

export const useUiStore = create<{
  tasksOpen: boolean;
  setTasksOpen: (open: boolean) => void;
}>((set) => ({
  tasksOpen: false,
  setTasksOpen: (tasksOpen) => set({ tasksOpen }),
}));
