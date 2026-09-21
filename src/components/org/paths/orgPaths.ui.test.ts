import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "@/components/ui/dialog";
import type { AdminFailure, PathCourseChoice } from "@/lib/admin-path-client";
import type { AdminCourseView } from "@/lib/admin-path-view";

const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
vi.mock("gooey-toast", () => ({ toast: { success: () => {}, error: () => {} } }));
// The alert dialog's parts only exist inside its portalled content, which Radix draws
// in a browser. Plain elements stand in so the confirmation's own words and controls
// can be read; the real frame is proved in the browser run.
vi.mock("@/components/ui/alert-dialog", async () => {
  const { createElement: h } = await import("react");
  const part = (tag: string) => (props: Record<string, unknown>) => {
    const { children, className, disabled } = props as {
      children?: React.ReactNode;
      className?: string;
      disabled?: boolean;
    };
    return h(tag, { className, disabled }, children);
  };
  return {
    AlertDialog: ({ children }: { children?: React.ReactNode }) => h("div", null, children),
    AlertDialogContent: part("div"),
    AlertDialogTitle: part("h2"),
    AlertDialogDescription: part("p"),
    AlertDialogFooter: part("div"),
    AlertDialogCancel: part("button"),
    AlertDialogAction: part("button"),
  };
});

const { AddCourseBody, filterChoices } = await import("./AddCourseDialog");
const { ConfirmBody, ConfirmPathDialog } = await import("./ConfirmPathDialog");
const { CreatePathBody, CreatePathDialog } = await import("./CreatePathDialog");
const { FailureNotice } = await import("./FailureNotice");
const { OrgPathsClient } = await import("./OrgPathsClient");
const { PathCourseList } = await import("./PathCourseList");
const { PathEditor } = await import("./PathEditor");
const { PathMetadataForm } = await import("./PathMetadataForm");
const { PathStatusBadge } = await import("./PathStatusBadge");
const { PublishBody, PublishPathDialog } = await import("./PublishPathDialog");

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

const failure = (over: Partial<AdminFailure> = {}): AdminFailure => ({
  message: "This path can't be published yet.",
  code: "PATH_NOT_PUBLISHABLE",
  status: 409,
  problems: [],
  refresh: true,
  ...over,
});

const view = (id: string, title: string, over: Partial<AdminCourseView> = {}): AdminCourseView => ({
  courseId: id,
  slug: `${id}-slug`,
  title,
  positionLabel: "01",
  statusLabel: "Published",
  courseStatus: "PUBLISHED",
  blockNote: null,
  ...over,
});

const noop = () => {};

// The attribute, not the `disabled:` utility classes every control carries.
const DISABLED = ' disabled=""';

describe("PathStatusBadge", () => {
  it("tells all three statuses apart by word, icon and data attribute, not colour alone", () => {
    const badges = (["DRAFT", "PUBLISHED", "ARCHIVED"] as const).map((status) =>
      render(createElement(PathStatusBadge, { status }))
    );

    expect(badges[0]).toContain("Draft");
    expect(badges[1]).toContain("Published");
    expect(badges[2]).toContain("Archived");
    expect(badges.map((b) => b.match(/data-status="(\w+)"/)?.[1])).toEqual([
      "DRAFT",
      "PUBLISHED",
      "ARCHIVED",
    ]);
    for (const badge of badges) expect(badge).toContain('aria-hidden="true"');
    expect(new Set(badges.map((b) => b.match(/<svg[^>]*class="([^"]*)"/)?.[1])).size).toBe(3);
  });
});

describe("FailureNotice", () => {
  it("is an alert with the message", () => {
    const html = render(createElement(FailureNotice, { failure: failure() }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("This path can&#x27;t be published yet.");
  });

  it("lists the blocking courses exactly as the server named them", () => {
    const html = render(
      createElement(FailureNotice, {
        failure: failure({
          problems: [
            { kind: "COURSE", courseId: "c1", title: "Leadership Basics", reason: "NOT_PUBLISHED" },
            { kind: "COURSE", courseId: "c2", title: "Advanced Negotiation", reason: "ARCHIVED" },
          ],
        }),
      })
    );

    expect(html).toContain("2 courses need attention:");
    expect(html).toContain("Leadership Basics isn&#x27;t published");
    expect(html).toContain("Advanced Negotiation is archived");
    expect(html).toContain("Review the affected courses and try again.");
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it("shows no list when the server sent no problems", () => {
    const html = render(
      createElement(FailureNotice, {
        failure: failure({ code: "DUPLICATE", message: "Already there." }),
      })
    );
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("Review the affected courses");
  });

  it("shows a course the server gave only by id without inventing a title", () => {
    const html = render(
      createElement(FailureNotice, {
        failure: failure({
          problems: [{ kind: "COURSE", courseId: "secret", reason: "WRONG_TENANT" }],
        }),
      })
    );
    expect(html).toContain("A course isn&#x27;t part of your organisation");
    expect(html).not.toContain("secret");
  });
});

describe("PathCourseList", () => {
  const courses = [
    view("a", "Alpha"),
    view("b", "Beta"),
    view("c", "Gamma", {
      blockNote: "This course isn't published yet",
      courseStatus: "DRAFT",
      statusLabel: "Draft",
    }),
  ];
  const list = (over: { editable?: boolean; busy?: boolean } = {}) =>
    render(
      createElement(PathCourseList, {
        courses,
        editable: over.editable ?? true,
        busy: over.busy ?? false,
        onRemove: noop,
        onSaveOrder: async () => null,
      })
    );

  it("is an ordered list of the courses in the server's order, numbered 01..n", () => {
    const html = list();

    expect(html).toContain("<ol");
    expect(html).toContain('aria-label="Courses in this path, in order"');
    expect([...html.matchAll(/>(0\d)</g)].map((m) => m[1])).toEqual(["01", "02", "03"]);
    expect([...html.matchAll(/data-course-id="(\w)"/g)].map((m) => m[1])).toEqual(["a", "b", "c"]);
  });

  it("gives every icon-only control an accessible name that says which course", () => {
    const html = list();

    for (const title of ["Alpha", "Beta", "Gamma"]) {
      expect(html).toContain(`aria-label="Drag to reorder ${title}"`);
      expect(html).toContain(`aria-label="Move ${title} up"`);
      expect(html).toContain(`aria-label="Move ${title} down"`);
      expect(html).toContain(`aria-label="Remove ${title} from this path"`);
    }
  });

  it("offers a button alternative to dragging, and disables the moves that go nowhere", () => {
    const html = list();
    const button = (label: string) =>
      html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";

    expect(button("Move Alpha up")).toContain(DISABLED);
    expect(button("Move Alpha down")).not.toContain(DISABLED);
    expect(button("Move Gamma down")).toContain(DISABLED);
    expect(button("Move Gamma up")).not.toContain(DISABLED);
  });

  it("disables every control while another change is being saved", () => {
    const html = list({ busy: true });
    const controls = html.match(/<button[^>]*aria-label="(Drag|Move|Remove)[^>]*>/g) ?? [];
    expect(controls).toHaveLength(12);
    for (const control of controls) expect(control).toContain(DISABLED);
  });

  it("is read-only when the path is: no drag handle, no move, no remove", () => {
    const html = list({ editable: false });

    expect(html).not.toContain("<button");
    expect(html).toContain("Alpha");
    expect(html).toContain("<ol");
  });

  it("shows the course's status and the reason the API gave for a blocked one, as words", () => {
    const html = list();
    expect(html).toContain("Course draft");
    expect(html).toContain("This course isn&#x27;t published yet");
  });

  it("has no save bar until the order changes", () => {
    expect(list()).not.toContain("Save order");
  });

  it("makes each drag handle a focusable button that touch can drag", () => {
    const html = list();
    const handle = html.match(/<button[^>]*aria-label="Drag to reorder Alpha"[^>]*>/)?.[0] ?? "";
    expect(handle).toContain("touch-action:none");
    expect(handle).toContain('type="button"');
  });
});

describe("PathMetadataForm", () => {
  const form = (busy = false) =>
    render(
      createElement(PathMetadataForm, {
        initial: { title: "Leadership", description: "About it" },
        busy,
        onSave: async () => null,
      })
    );

  it("labels both fields and starts from what the server holds", () => {
    const html = form();

    expect(html).toContain('for="edit-path-title"');
    expect(html).toContain('id="edit-path-title"');
    expect(html).toContain('value="Leadership"');
    expect(html).toContain('for="edit-path-description"');
    expect(html).toContain(">About it</textarea>");
  });

  it("bounds the inputs with the domain's limits and marks the title required", () => {
    const html = form();
    expect(html).toContain('maxLength="100"');
    expect(html).toContain('maxLength="1000"');
    expect(html).toContain("required");
  });

  it("cannot be saved until something changes", () => {
    expect(form()).toMatch(/<button[^>]* disabled=""[^>]*>Save details/);
    expect(form(true)).toMatch(/<button[^>]* disabled=""[^>]*>Save details/);
  });
});

describe("dialogs", () => {
  // Radix draws a dialog's frame (role, focus trap, Escape) only in a browser, so
  // the bodies are rendered inside their real roots here and the frames are proved
  // in the browser run. What each dialog says and labels is what is tested.
  const inDialog = (body: ReturnType<typeof createElement>) =>
    render(createElement(Dialog, { open: true }, body));

  it("keeps the frames closed, drawing nothing, until they are opened", () => {
    expect(
      render(createElement(CreatePathDialog, { open: false, onOpenChange: noop, onCreated: noop }))
    ).not.toContain("dialog");
    expect(
      render(
        createElement(ConfirmPathDialog, { copy: null, onConfirm: async () => null, onClose: noop })
      )
    ).not.toContain("dialog");
    expect(
      render(
        createElement(PublishPathDialog, {
          open: false,
          republish: false,
          pathTitle: "x",
          onConfirm: async () => null,
          onClose: noop,
        })
      )
    ).not.toContain("dialog");
  });

  it("names the create dialog, labels both fields and offers cancel and create", () => {
    const html = inDialog(createElement(CreatePathBody, { onClose: noop, onCreated: noop }));

    expect(html).toContain("<form");
    expect(html).toContain('for="create-path-title"');
    expect(html).toContain('for="create-path-description"');
    expect(html).toContain("Cancel");
    expect(html).toContain(">Create<");
  });

  it("confirms with the existing alert dialog's parts, naming what is at stake", () => {
    const html = render(
      createElement(ConfirmBody, {
        copy: {
          title: "Remove course?",
          description: 'This will remove "Leadership Basics" from this path.',
          confirmLabel: "Remove",
          pendingLabel: "Removing…",
          cancelLabel: "Keep course",
        },
        onConfirm: async () => null,
        onClose: noop,
      })
    );

    expect(html).toContain("<h2");
    expect(html).toContain("Remove course?");
    expect(html).toContain("Leadership Basics");
    expect(html).toContain("Keep course");
    expect(html).toContain(">Remove<");
    expect(html).not.toContain("Removing");
  });

  it("words publish and republish differently but asks the same question", () => {
    const body = (republish: boolean) =>
      inDialog(
        createElement(PublishBody, {
          republish,
          pathTitle: "Leadership",
          onConfirm: async () => null,
          onClose: noop,
        })
      );

    const publish = body(false);
    const republish = body(true);
    expect(publish).toContain("Publish this learning path?");
    expect(publish).toContain(">Publish<");
    expect(publish).toContain("Leadership");
    expect(republish).toContain("Republish this learning path?");
    expect(republish).toContain(">Republish<");
    expect(republish).toContain("their progress as it stands now");
  });

  const choices: PathCourseChoice[] = [
    { id: "a", title: "Alpha", slug: "alpha", status: "PUBLISHED" },
    { id: "b", title: "Beta", slug: "beta-slug", status: "DRAFT" },
  ];

  const addBody = (list: PathCourseChoice[], members: string[]) =>
    inDialog(
      createElement(AddCourseBody, {
        choices: list,
        memberIds: new Set<string>(members),
        onAdd: async () => null,
        onClose: noop,
      })
    );

  it("lists the courses to pick from, marks the ones already in the path, and labels each add", () => {
    const html = addBody(choices, ["a"]);

    expect(html).toContain("Add a course");
    expect(html).toContain('for="add-course-search"');
    expect(html).toContain("2 of 2 courses");
    expect(html).toContain("In this path");
    expect(html).toContain('aria-label="Add Beta to this path"');
    expect(html).not.toContain('aria-label="Add Alpha to this path"');
    expect(html).toContain("Course published");
    expect(html).toContain("Course draft");
  });

  it("says so when there is nothing to choose from", () => {
    const html = addBody([], []);
    expect(html).toContain("Your organisation has no courses to add yet.");
    expect(html).not.toContain("Add </");
  });

  it("searches only within the courses it was given, by title or slug", () => {
    expect(filterChoices(choices, "").map((c) => c.id)).toEqual(["a", "b"]);
    expect(filterChoices(choices, "  ALP ").map((c) => c.id)).toEqual(["a"]);
    expect(filterChoices(choices, "beta-s").map((c) => c.id)).toEqual(["b"]);
    expect(filterChoices(choices, "zzz")).toEqual([]);
  });
});

describe("screens before their data arrives", () => {
  it("draws the list header, the create action and a labelled status filter while loading", () => {
    search.value = "";
    const html = render(createElement(OrgPathsClient));

    expect(html).toContain("<h1");
    expect(html).toContain("Learning Paths");
    expect(html).toContain("Create path");
    expect(html).toContain('aria-label="Filter learning paths by status"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading learning paths");
  });

  it("marks exactly the filter the URL names as current, and links each filter into the URL", () => {
    search.value = "status=PUBLISHED";
    const html = render(createElement(OrgPathsClient));

    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="true"[^>]*>Published</);
    expect(html).toContain('href="/org/paths?status=DRAFT"');
    expect(html).toContain('href="/org/paths?status=ARCHIVED"');
    expect(html).toContain('href="/org/paths"');
  });

  it("ignores a status the URL invented rather than sending it to the API", () => {
    search.value = "status=DELETED";
    const html = render(createElement(OrgPathsClient));
    expect(html).toMatch(/aria-current="true"[^>]*>All</);
  });

  it("draws a skeleton, not a blank page, while the editor loads", () => {
    const html = render(createElement(PathEditor, { pathId: "p1", courseChoices: [] }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading learning path");
    expect(html).not.toContain("<h1");
  });
});
