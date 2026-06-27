"use client";

import { useEffect } from "react";
import { mountToaster } from "gooey-toast";
import "gooey-toast/styles.css";

export function GooeyToaster() {
  useEffect(() => {
    mountToaster({ position: "bottom-right" });
  }, []);

  return null;
}
