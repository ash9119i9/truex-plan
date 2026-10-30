import { useSyncExternalStore } from "react";

// Transient confirmations (DESIGN-SPEC 9.15): 4.5 s by default, longer copy gets
// words ÷ 3.33 + 0.9 s (9.1), at most three at once, oldest leaves first.
export type ToastTone = "ok" | "warn" | "bad";
export type Toast = {
  id: number;
  title: string;
  body?: string;
  tone?: ToastTone;
};

export const TOAST_LIMIT = 3;
const BASE_MS = 4500;

export function toastLifetime(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(BASE_MS, Math.round((words / 3.33 + 0.9) * 1000));
}

export function createToasts() {
  let list: Toast[] = [];
  let next = 1;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    push(toast: Omit<Toast, "id">) {
      const id = next++;
      list = [...list, { ...toast, id }].slice(-TOAST_LIMIT);
      emit();
      return id;
    },
    dismiss(id: number) {
      list = list.filter((toast) => toast.id !== id);
      emit();
    },
    list: () => list,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const shared = createToasts();
const NONE: Toast[] = [];

export function toast(toast: Omit<Toast, "id">) {
  const id = shared.push(toast);
  setTimeout(
    () => shared.dismiss(id),
    toastLifetime(`${toast.title} ${toast.body ?? ""}`),
  );
}

export const dismissToast = (id: number) => shared.dismiss(id);

export function useToasts() {
  return useSyncExternalStore(shared.subscribe, shared.list, () => NONE);
}
