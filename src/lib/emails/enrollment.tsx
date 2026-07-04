import { Text } from "react-email";

import { EmailLayout, emailStyles } from "./EmailLayout";

interface EnrollmentEmailProps {
  name: string;
  courseTitle: string;
  courseUrl: string;
}

export function EnrollmentEmail({ name, courseTitle, courseUrl }: EnrollmentEmailProps) {
  return (
    <EmailLayout previewText={`You're enrolled in ${courseTitle}`}>
      <Text style={emailStyles.heading}>You&apos;re in, {name}!</Text>
      <Text style={emailStyles.body}>
        You&apos;re now enrolled in <strong>{courseTitle}</strong>. Jump in and start learning at
        your own pace.
      </Text>
      <a href={courseUrl} style={emailStyles.button}>
        Start learning →
      </a>
    </EmailLayout>
  );
}
