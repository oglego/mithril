import { load, equal, pass } from "../_lib.mjs";

const { slugify, capitalize } = await load("src/strings.mjs");
equal(slugify("  Hello, World!  "), "hello-world", "spaces and punctuation");
equal(slugify("Already-slugged"), "already-slugged", "existing hyphen");
equal(slugify("a  b   c"), "a-b-c", "runs of spaces");
equal(slugify("!!!"), "", "nothing left");
equal(slugify("Node.js 20"), "node-js-20", "digits and dots");
equal(capitalize("word"), "Word", "capitalize must keep working");
pass();
