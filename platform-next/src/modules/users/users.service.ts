import { Inject, Injectable } from "@nestjs/common";
import { ObjectId, type ClientSession, type Collection } from "mongodb";
import { DomainError } from "../../common/domain-error";
import { DatabaseService } from "../../database/database.service";
import {
  duplicateKeyFields,
  isDuplicateKeyError,
} from "../../database/mongo-errors";
import {
  USERS_COLLECTION,
  emailKeyOf,
  identityKeyOf,
  parseVerifiedIdentity,
  type UserDoc,
  type VerifiedIdentity,
} from "./user";

const EMAIL_IN_USE = () =>
  new DomainError(
    "CONFLICT",
    "Another account already uses this email address. Sign in with that account instead.",
  );

const ACCOUNT_DISABLED = () =>
  new DomainError("FORBIDDEN", "This account is disabled.");

// Global accounts, keyed by verified identity. An identity maps to exactly one
// account; an email already used by another account is rejected, not linked.
@Injectable()
export class UsersService {
  private indexesReady?: Promise<void>;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private users(): Collection<UserDoc> {
    return this.database.catalog().collection<UserDoc>(USERS_COLLECTION);
  }

  ensureIndexes(): Promise<void> {
    this.indexesReady ??= this.createIndexes().catch((error: unknown) => {
      this.indexesReady = undefined;
      throw error;
    });
    return this.indexesReady;
  }

  private async createIndexes(): Promise<void> {
    await this.users().createIndexes([
      { key: { identityKeys: 1 }, name: "identity_unique", unique: true },
      { key: { emailKey: 1 }, name: "emailKey_unique", unique: true },
    ]);
  }

  // Returns the account for a verified identity, creating it on first sign-in.
  // Inside a transaction a duplicate-key race aborts the transaction, so the
  // caller must retry the whole transaction; outside one it reads the winner.
  async findOrCreateFromIdentity(
    input: VerifiedIdentity,
    session?: ClientSession,
  ): Promise<{ user: UserDoc; created: boolean }> {
    const profile = parseVerifiedIdentity(input);
    await this.ensureIndexes();
    const identityKey = identityKeyOf(profile.identity);

    const existing = await this.users().findOne(
      { identityKeys: identityKey },
      { session },
    );
    if (existing) return { user: assertActive(existing), created: false };

    const now = new Date();
    const user: UserDoc = {
      _id: new ObjectId(),
      identities: [profile.identity],
      identityKeys: [identityKey],
      email: profile.email,
      emailKey: profile.emailKey,
      name: profile.name,
      ...(profile.picture ? { picture: profile.picture } : {}),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.users().insertOne(user, { session });
      return { user, created: true };
    } catch (error) {
      if (!isDuplicateKeyError(error) || session) throw error;
      // A concurrent first sign-in of the same identity can collide on either
      // index, so look for the winner before calling it an email collision.
      const winner = await this.users().findOne({ identityKeys: identityKey });
      if (winner) return { user: assertActive(winner), created: false };
      if (duplicateKeyFields(error).includes("emailKey")) throw EMAIL_IN_USE();
      throw error;
    }
  }

  async recordLogin(
    userId: ObjectId,
    now: Date,
    session?: ClientSession,
  ): Promise<void> {
    await this.users().updateOne(
      { _id: userId },
      { $set: { lastLoginAt: now } },
      { session },
    );
  }

  findById(userId: ObjectId, session?: ClientSession): Promise<UserDoc | null> {
    return this.users().findOne({ _id: userId }, { session });
  }

  findByEmail(email: string, session?: ClientSession): Promise<UserDoc | null> {
    return this.users().findOne({ emailKey: emailKeyOf(email) }, { session });
  }
}

function assertActive(user: UserDoc): UserDoc {
  if (user.status !== "active") throw ACCOUNT_DISABLED();
  return user;
}
