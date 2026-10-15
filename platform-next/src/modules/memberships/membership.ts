import type { ObjectId } from "mongodb";

export type Role = "user" | "admin";
export type MembershipStatus = "active" | "removed";
export type JoinedVia = "signup" | "invitation" | "operator";

export const ROLES: readonly Role[] = ["user", "admin"];

// Connects one user to one tenant. The role lives here, so the same person can
// be an admin in one tenant and a user in another.
export interface MembershipDoc {
  _id: ObjectId;
  userId: ObjectId;
  tenantId: ObjectId;
  role: Role;
  status: MembershipStatus;
  joinedVia: JoinedVia;
  inviteId?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export const MEMBERSHIPS_COLLECTION = "memberships";

export function isRole(value: unknown): value is Role {
  return value === "user" || value === "admin";
}
