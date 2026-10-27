import { Inject, Injectable, Logger } from "@nestjs/common";
import { DomainError } from "../../common/domain-error";
import { DatabaseService } from "../../database/database.service";
import {
  duplicateKeyFields,
  isDuplicateKeyError,
} from "../../database/mongo-errors";
import { AuditService } from "../audit/audit.service";
import { MembershipsService } from "../memberships/memberships.service";
import {
  SessionsService,
  type IssuedSession,
} from "../sessions/sessions.service";
import { TenantsService } from "../tenants/tenants.service";
import type { UserDoc, VerifiedIdentity } from "../users/user";
import { UsersService } from "../users/users.service";
import {
  GoogleOidcClient,
  GoogleRejectedError,
  GoogleUnavailableError,
} from "./google-oidc";

// Why sign-in did not finish. Each value is a fixed code the login screen
// turns into a message; nothing from the request is ever reflected.
export type SignInFailure =
  | "cancelled" // the user backed out at Google
  | "expired" // the attempt is stale or from another tab; start again
  | "rejected" // Google's answer could not be trusted
  | "unavailable" // Google or our database is down; retry
  | "account_disabled"
  | "email_in_use" // another account already has this email
  | "signup_unavailable"; // no usable default tenant to join

export class SignInError extends Error {
  constructor(readonly failure: SignInFailure) {
    super(`Sign-in failed: ${failure}`);
    this.name = "SignInError";
  }
}

export interface SignedIn {
  user: UserDoc;
  created: boolean;
  session: IssuedSession;
}

// A duplicate-key race aborts the whole transaction; the retry then finds
// the winner's account.
const ENROLL_ATTEMPTS = 3;

@Injectable()
export class AuthService {
  private readonly logger = new Logger("Auth");

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GoogleOidcClient) private readonly google: GoogleOidcClient,
  ) {}

  // Completes a Google sign-in: verify Google's answer, create or find the
  // account (a new one joins the default tenant as "user"), start a session.
  async signInWithGoogle(
    code: string,
    codeVerifier: string,
    nonce: string,
  ): Promise<SignedIn> {
    let identity: VerifiedIdentity;
    try {
      const idToken = await this.google.exchangeCode(code, codeVerifier);
      identity = await this.google.verifyIdToken(idToken, nonce);
    } catch (error) {
      if (error instanceof GoogleUnavailableError)
        throw new SignInError("unavailable");
      if (error instanceof GoogleRejectedError) {
        this.logger.warn({ message: error.message });
        throw new SignInError("rejected");
      }
      throw error;
    }

    const { user, created } = await this.enroll(identity);
    const session = await this.sessions.create(user._id);
    await this.users.recordLogin(user._id, new Date());
    await this.audit.record({
      action: created ? "auth.signup" : "auth.login",
      actor: { kind: "user", userId: user._id },
      result: "success",
      targetUserId: user._id,
      details: {
        provider: "google",
        sessionId: session.sessionId.toHexString(),
      },
    });
    return { user, created, session };
  }

  // One transaction: the account and its default membership exist together
  // or not at all. Returning accounts keep their memberships as they are; a
  // removed membership stays removed.
  private async enroll(
    identity: VerifiedIdentity,
  ): Promise<{ user: UserDoc; created: boolean }> {
    // Index builds stay outside the transaction.
    await Promise.all([
      this.users.ensureIndexes(),
      this.memberships.ensureIndexes(),
    ]);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.database.withTransaction(async (session) => {
          const result = await this.users.findOrCreateFromIdentity(
            identity,
            session,
          );
          const tenant = await this.tenants.findDefaultUsable(session);
          if (!tenant) {
            if (result.created) throw new SignInError("signup_unavailable");
            return result;
          }
          const existing = await this.memberships.find(
            result.user._id,
            tenant._id,
            session,
          );
          if (!existing)
            await this.memberships.join(
              {
                userId: result.user._id,
                tenantId: tenant._id,
                joinedVia: "signup",
              },
              session,
            );
          return result;
        });
      } catch (error) {
        if (error instanceof DomainError) {
          if (error.code === "FORBIDDEN")
            throw new SignInError("account_disabled");
          if (error.code === "INVALID_INPUT") throw new SignInError("rejected");
          throw error;
        }
        if (!isDuplicateKeyError(error)) throw error;
        // A second collision on email (not identity) is a different account.
        if (attempt > 1 && duplicateKeyFields(error).includes("emailKey"))
          throw new SignInError("email_in_use");
        if (attempt >= ENROLL_ATTEMPTS) throw error;
      }
    }
  }
}
