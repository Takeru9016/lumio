"use client";

import { mountToaster } from "gooey-toast";
import { useEffect } from "react";
import "gooey-toast/styles.css";

export function GooeyToaster() {
  useEffect(() => {
    mountToaster({ position: "top-center" });
  }, []);

  return null;
}
