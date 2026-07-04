import { Text } from "react-email";

import { EmailLayout, emailStyles } from "./EmailLayout";

interface CertificateEmailProps {
  name: string;
  courseTitle: string;
  certUrl: string;
  certId: string;
}

export function CertificateEmail({ name, courseTitle, certUrl, certId }: CertificateEmailProps) {
  return (
    <EmailLayout previewText={`Your certificate for ${courseTitle} is ready`}>
      <Text style={emailStyles.heading}>Congratulations, {name}!</Text>
      <Text style={emailStyles.body}>You&apos;ve successfully completed:</Text>
      <Text style={{ fontSize: "17px", fontWeight: 600, color: "#4f6ef7", margin: "0 0 28px" }}>
        {courseTitle}
      </Text>
      <Text style={emailStyles.body}>
        Your certificate is ready. You can view and share it at any time using the link below.
      </Text>
      <a href={certUrl} style={emailStyles.button}>
        View certificate →
      </a>
      <Text style={emailStyles.muted}>Certificate ID: {certId}</Text>
    </EmailLayout>
  );
}
