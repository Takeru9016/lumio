import { Text } from "react-email";

import { EmailLayout, emailStyles } from "./EmailLayout";

interface WelcomeEmailProps {
  name: string;
  dashboardUrl: string;
}

export function WelcomeEmail({ name, dashboardUrl }: WelcomeEmailProps) {
  return (
    <EmailLayout previewText="Welcome to Lumio">
      <Text style={emailStyles.heading}>Welcome, {name}!</Text>
      <Text style={emailStyles.body}>
        Your Lumio account is ready. Lumio pairs your courses with an AI tutor so you can learn
        faster and get unstuck the moment you need help.
      </Text>
      <a href={dashboardUrl} style={emailStyles.button}>
        Go to your dashboard →
      </a>
    </EmailLayout>
  );
}
