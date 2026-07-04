import type { ReactNode } from "react";
import { Body, Container, Head, Hr, Html, Preview, Text } from "react-email";

interface EmailLayoutProps {
  previewText: string;
  children: ReactNode;
}

export function EmailLayout({ previewText, children }: EmailLayoutProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={{ backgroundColor: "#f5f5f6", margin: 0, padding: "32px 0" }}>
        <Container
          style={{
            backgroundColor: "#ffffff",
            border: "1px solid #e5e5e7",
            borderRadius: "12px",
            maxWidth: "560px",
            padding: "40px",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <Text style={{ fontSize: "22px", fontWeight: 700, color: "#4f6ef7", margin: "0 0 24px" }}>
            ✦ Lumio
          </Text>
          {children}
          <Hr style={{ border: "none", borderTop: "1px solid #e5e5e7", margin: "32px 0 16px" }} />
          <Text style={{ fontSize: "12px", color: "#a8a8b0", margin: 0 }}>— The Lumio Team</Text>
        </Container>
      </Body>
    </Html>
  );
}

export const emailStyles = {
  heading: {
    fontSize: "22px",
    fontWeight: 700,
    color: "#0f0f10",
    margin: "0 0 12px",
    letterSpacing: "-0.02em",
  },
  body: { fontSize: "15px", color: "#3d3d3f", margin: "0 0 16px", lineHeight: "1.5" },
  muted: { fontSize: "12px", color: "#a8a8b0", margin: "16px 0 0" },
  button: {
    display: "inline-block",
    backgroundColor: "#4f6ef7",
    color: "#ffffff",
    textDecoration: "none",
    padding: "12px 24px",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: 600,
  },
} as const;
