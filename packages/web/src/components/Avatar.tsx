import type { PublicUser } from "@peer-cast/shared";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

export function Avatar({
  user,
  size = 40,
}: {
  user: Pick<PublicUser, "displayName" | "avatarUrl">;
  size?: number;
}) {
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={user.displayName}
        width={size}
        height={size}
        className="rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center rounded-full bg-brand-600 font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials(user.displayName)}
    </div>
  );
}
