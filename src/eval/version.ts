// Bumped whenever the ENVIRONMENT the agent works in changes in a way that can
// move results: how refusals are worded, how tools report errors, and so on.
// The prompt fingerprint already covers the system prompt and tool
// definitions; this covers everything else. Results files record it, and
// --compare warns when two files were produced by different versions, so an
// old baseline is never silently compared against a changed environment.
//
//   1  (not recorded) the first release
//   2  refused commands explain why and what to do instead
//   3  edit_file errors say which field is which and what to do next; an edit
//      whose target and replacement are identical is now an error
export const HARNESS_VERSION = 3;
