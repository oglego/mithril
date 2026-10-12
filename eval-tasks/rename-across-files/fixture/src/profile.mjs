import { getUser } from "./users.mjs";

export function profileLine(id) {
  const user = getUser(id);
  return `${user.id}: ${user.name}`;
}
