import { load, read, run, ensure, equal, pass } from "../_lib.mjs";

const users = await load("src/users.mjs");
ensure(typeof users.fetchUser === "function", "src/users.mjs must export fetchUser");
ensure(users.getUser === undefined, "src/users.mjs must no longer export getUser");
for (const file of ["src/users.mjs", "src/profile.mjs", "src/main.mjs"]) {
  ensure(!read(file).includes("getUser"), `${file} still mentions getUser`);
}
const result = run(["src/main.mjs"]);
ensure(result.status === 0, `src/main.mjs crashed: ${result.stderr.split("\n")[0]}`);
equal(result.stdout, "1: user1\nuser2\n", "program output");
pass();
