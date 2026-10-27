import type { ObjectId } from "mongodb";
import { DomainError } from "../../common/domain-error";

// Google now; enterprise SSO providers are added here when they ship.
export type IdentityProvider = "google";
export const IDENTITY_PROVIDERS: readonly IdentityProvider[] = ["google"];

export type UserStatus = "active" | "disabled";

export interface Identity {
  provider: IdentityProvider;
  subject: string;
}

// A global account. It has no tenant role: roles live on memberships.
export interface UserDoc {
  _id: ObjectId;
  identities: Identity[];
  // `provider|subject` for each identity, unique across all users. A unique
  // index over two fields of the same array would combine values from
  // different elements, so uniqueness is enforced on this single key instead.
  identityKeys: string[];
  email: string;
  emailKey: string;
  name: string;
  picture?: string;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

export const USERS_COLLECTION = "users";

// What an identity provider vouched for after its token was verified.
export interface VerifiedIdentity {
  provider: IdentityProvider;
  subject: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

export interface NewUserProfile {
  identity: Identity;
  email: string;
  emailKey: string;
  name: string;
  picture?: string;
}

const SUBJECT = /^[\x21-\x7e]{1,255}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 100;
const MAX_PICTURE_LENGTH = 2048;
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}]/u;

export function identityKeyOf(identity: Identity): string {
  return `${identity.provider}|${identity.subject}`;
}

// The comparison form of an email. Used to detect collisions, never to link
// two identities into one account.
export function emailKeyOf(email: string): string {
  return email.normalize("NFC").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return (
    email.length <= MAX_EMAIL_LENGTH &&
    EMAIL.test(email) &&
    !UNSAFE_CHARS.test(email)
  );
}

function displayNameOf(value: unknown, email: string): string {
  if (typeof value === "string") {
    const name = value.normalize("NFC").trim();
    if (
      name.length > 0 &&
      name.length <= MAX_NAME_LENGTH &&
      !UNSAFE_CHARS.test(name)
    )
      return name;
  }
  // A missing or unusable name falls back to the email's local part.
  return email.slice(0, email.indexOf("@")).slice(0, MAX_NAME_LENGTH);
}

// The picture is cosmetic, so an unusable URL is dropped rather than failing
// sign-in. Only https URLs are kept so the browser never loads mixed content.
function pictureOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_PICTURE_LENGTH)
    return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function parseVerifiedIdentity(input: VerifiedIdentity): NewUserProfile {
  if (!IDENTITY_PROVIDERS.includes(input.provider))
    throw new DomainError("INVALID_INPUT", "Unsupported identity provider.");
  if (typeof input.subject !== "string" || !SUBJECT.test(input.subject))
    throw new DomainError(
      "INVALID_INPUT",
      "The identity subject is not valid.",
    );
  if (input.emailVerified !== true)
    throw new DomainError(
      "FORBIDDEN",
      "The identity provider has not verified this email address.",
    );
  const email =
    typeof input.email === "string" ? input.email.normalize("NFC").trim() : "";
  if (!isValidEmail(email))
    throw new DomainError("INVALID_INPUT", "The email address is not valid.");

  const picture = pictureOf(input.picture);
  return {
    identity: { provider: input.provider, subject: input.subject },
    email,
    emailKey: emailKeyOf(email),
    name: displayNameOf(input.name, email),
    ...(picture ? { picture } : {}),
  };
}
