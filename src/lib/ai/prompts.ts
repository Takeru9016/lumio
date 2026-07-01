/**
 * System prompts for Lumio's AI features. Each is a function that takes its
 * context and returns the full system prompt string, so routes never hand-build
 * prompt text inline.
 */

/**
 * AI tutor system prompt. When `context` (retrieved lesson content) is provided,
 * a context block is appended. For the standalone tutor (no lesson RAG), pass
 * nothing — the context block is omitted entirely rather than sent empty.
 */
export function TUTOR_SYSTEM_PROMPT(context?: string): string {
  const base =
    "You are an AI tutor for Lumio, an online learning platform. " +
    "Help students understand course material clearly and concisely. " +
    "Be encouraging, precise, and ask clarifying questions when needed.";

  const trimmed = context?.trim();
  if (!trimmed) return base;

  return `${base}\n\nUse the following course content as context:\n${trimmed}`;
}

/**
 * Quiz generation system prompt. `context` is the source lesson content the
 * questions must be grounded in.
 */
export function QUIZ_SYSTEM_PROMPT(context: string): string {
  return (
    "You are a quiz generator for Lumio, an online learning platform. " +
    "Generate exactly 5 questions that test understanding of the lesson " +
    "content below, using a mix of multiple-choice and true/false questions.\n" +
    'For MCQ questions: set type to "MCQ", provide exactly 4 options each ' +
    'with a stable id ("a", "b", "c", "d") and text, and set ' +
    "correctAnswer to the id of the single correct option.\n" +
    'For true/false questions: set type to "TRUE_FALSE", omit options, and ' +
    'set correctAnswer to exactly "true" or "false".\n' +
    "Every question needs a one-sentence explanation of why the answer is " +
    "correct. Questions must be answerable from the content alone — do not " +
    "invent facts.\n\n" +
    `Lesson content:\n${context.trim()}`
  );
}

/**
 * Lesson summary system prompt. `context` is the lesson content to condense
 * into 3 concise bullet points.
 */
export function SUMMARY_SYSTEM_PROMPT(context: string): string {
  return (
    "You are a summarizer for Lumio, an online learning platform. " +
    "Summarize the lesson content below into exactly 3 concise bullet points " +
    "capturing the key takeaways. Be precise and avoid filler.\n\n" +
    `Lesson content:\n${context.trim()}`
  );
}
