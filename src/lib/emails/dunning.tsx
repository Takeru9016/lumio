import { Text } from "react-email";

import { EmailLayout, emailStyles } from "./EmailLayout";

interface DunningEmailProps {
  name: string;
  billingUrl: string;
}

export function DunningEmail({ name, billingUrl }: DunningEmailProps) {
  return (
    <EmailLayout previewText="Action needed: your Lumio payment failed">
      <Text style={emailStyles.heading}>Hi {name},</Text>
      <Text style={emailStyles.body}>
        We couldn&apos;t process your latest Lumio subscription payment, so your account is now
        marked <strong>past due</strong>.
      </Text>
      <Text style={emailStyles.body}>
        Please update your payment method to keep your plan active and avoid losing access to
        premium features.
      </Text>
      <a href={billingUrl} style={emailStyles.button}>
        Update payment method →
      </a>
    </EmailLayout>
  );
}
