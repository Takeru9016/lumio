import { UsersClient } from "@/components";
import { searchUsers } from "@/lib/admin-users";

export default async function AdminUsersPage() {
  const users = await searchUsers({});

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1
          className="text-xl font-semibold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Users
        </h1>
        <p className="text-sm text-text-muted">
          Showing the {users.length} most recently joined users. Search to find others.
        </p>
      </div>

      <UsersClient initialUsers={users} />
    </div>
  );
}
