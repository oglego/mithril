import { fetchUser } from "./users.mjs";

export function profileLine(id) {
  const user = fetchUser(id);
  return `${user.id}: ${user.name}`;
}
