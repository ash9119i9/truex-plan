// Shared by the server and the operator CLI: the same address must produce the
// same key in both (scripts/tenant.mjs implements emailKey separately).
// [typed address, expected key]. Gmail drops dots and +tags and folds
// googlemail.com into gmail.com; every other domain keeps them.
export const EMAIL_VECTORS: [string, string][] = [
  ["Ashok@Gmail.com", "ashok@gmail.com"],
  ["A.Shok+x@gmail.com", "ashok@gmail.com"],
  ["a.shok@googlemail.com", "ashok@gmail.com"],
  ["Jane.Doe+Sales@Acme.Example", "jane.doe+sales@acme.example"],
  ["jane.doe@acme.example", "jane.doe@acme.example"],
  ["janedoe@acme.example", "janedoe@acme.example"],
  ["person@gmail.com.evil.io", "person@gmail.com.evil.io"],
  ["first.last@sub.company.co.uk", "first.last@sub.company.co.uk"],
];
// Rejected by both: malformed, oversized, control or non-ASCII characters.
export const BAD_EMAILS = [
  "",
  "person",
  "person@",
  "@example.com",
  "a@b",
  "per son@example.com",
  "person@exa mple.com",
  "pers\u0000on@example.com",
  "per\u202eson@example.com",
  "bödy@example.com",
  "person@exämple.com",
  ".person@example.com",
  "person.@example.com",
  "pe..rson@example.com",
  "+tag@gmail.com",
  "a@b@example.com",
  "x".repeat(65) + "@example.com",
  "x@" + "y".repeat(250) + ".com",
];
