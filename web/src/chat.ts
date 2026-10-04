import { useEffect, useRef, useState } from "react";
import { readPreference, writePreference } from "./preferences";

export function useMessageDraft(key: string) {
  const [text, update] = useState(() => readPreference(key, ""));
  const current = useRef(text);
  const setText = (value: string) => {
    current.current = value;
    update(value);
    writePreference(key, value);
  };
  return { text, setText, current };
}

/** New messages follow the conversation only while the user is at the bottom. */
export function useChatScroll(count: number) {
  const container = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (following.current) end.current?.scrollIntoView({ block: "end" });
    else setUnread(true);
  }, [count]);
  const onScroll = () => {
    const el = container.current;
    if (!el) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    if (following.current) setUnread(false);
  };
  const jump = () => { following.current = true; setUnread(false); end.current?.scrollIntoView({ block: "end" }); };
  return { container, end, onScroll, unread, jump };
}
