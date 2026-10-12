import { load, equal, pass } from "../_lib.mjs";

const { paginate } = await load("src/paginate.mjs");
const items = [1, 2, 3, 4, 5];
equal(paginate(items, 1, 2), [1, 2], "page 1");
equal(paginate(items, 2, 2), [3, 4], "page 2");
equal(paginate(items, 3, 2), [5], "page 3 (partial)");
equal(paginate(items, 4, 2), [], "page past the end");
equal(paginate(items, 1, 10), items, "page larger than the list");
pass();
