import { create } from "zustand";

export type LeftView =
  | "chats"
  | "archived"
  | "calls"
  | "new-chat"
  | "new-group"
  | "starred"
  | "broadcasts"
  | "settings"
  | "settings-profile"
  | "settings-privacy"
  | "settings-devices"
  | "settings-blocked"
  | "settings-security"
  | "settings-notifications";

export type RightView = null | "info" | "search";

interface UI {
  left: LeftView;
  right: RightView;
  lightbox: { mediaId: string; mime: string } | null;
  forward: string | null; // message id
  messageInfo: string | null;
  setLeft(v: LeftView): void;
  setRight(v: RightView): void;
}

export const useUI = create<UI>((set) => ({
  left: "chats",
  right: null,
  lightbox: null,
  forward: null,
  messageInfo: null,
  setLeft: (left) => set({ left }),
  setRight: (right) => set({ right }),
}));
