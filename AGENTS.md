# AGENTS.md

## Purpose

This repository is developed with AI coding agents.

The goal is not merely to make code compile or pass tests. Every change must protect:

- Correctness
- Reliability
- Maintainability
- Security
- Performance
- Scalability
- Simplicity
- User experience
- Operational safety

AI-generated code is held to the same or higher standard as expert human-written code.

---

# Core Engineering Philosophy

For every task, operate in four modes:

1. **First-Principles Mode** — challenge assumptions and find the simplest correct solution.
2. **Break Mode** — actively try to destroy the design and implementation.
3. **Experimental Engineering Mode** — test assumptions against reality and measurable evidence.
4. **Product Simplicity Mode** — simplify the system, interface, API, and user experience.

The default loop is:

```text
Understand
  ↓
Question assumptions
  ↓
Design the simplest solution
  ↓
Implement the smallest safe change
  ↓
Try to break it
  ↓
Measure reality
  ↓
Fix weaknesses
  ↓
Simplify again
  ↓
Polish the experience
  ↓
Review final diff
  ↓
Ship
  ↓
Observe
```

---

# 1. Understand Before Coding

Never start by editing files.

First determine:

- What problem are we solving?
- Who or what depends on this behavior?
- What should happen?
- What should never happen?
- What is explicitly out of scope?
- What existing code controls this behavior?
- What are the acceptance criteria?

For bugs, determine:

- How is the bug reproduced?
- What is the expected behavior?
- What is the actual behavior?
- What is the root cause?
- Why did existing protections fail to catch it?

Do not patch symptoms when the root cause is identifiable.

---

# 2. Inspect the Existing System

Before making changes, inspect the relevant repository structure.

Understand:

- Entry points
- Call flow
- Module boundaries
- Existing abstractions
- Data models
- APIs
- Database access
- Queues and background jobs
- External services
- Configuration
- Error handling
- Logging
- Tests
- Deployment assumptions

Build a mental model:

```text
Input → Validation → Business Logic → State Change → Output
```

Prefer existing repository patterns over inventing new ones.

Do not introduce a new abstraction unless the current design cannot cleanly support the change.

---

# 3. First-Principles Mode

Before implementation, challenge the problem itself.

Ask:

- Why does this feature exist?
- What outcome actually matters?
- Which assumptions are inherited rather than necessary?
- Can a component be removed?
- Can a network call be removed?
- Can state be eliminated?
- Can this be synchronous instead of distributed?
- Can this be expressed with fewer abstractions?
- Can this feature be made 10× simpler?
- If this system were designed today, would we still choose this architecture?

Optimize for:

```text
Minimum complexity required
        +
Maximum correctness
        +
Clear future extensibility
```

Avoid cleverness for its own sake.

---

# 4. Define Acceptance Criteria

Before coding, write observable success conditions.

Acceptance criteria should cover:

- Expected behavior
- Invalid inputs
- Permissions
- Failure behavior
- State transitions
- Edge cases
- Backward compatibility
- Important performance constraints

Acceptance criteria should become tests wherever practical.

---

# 5. Plan the Smallest Safe Change

Before modifying code, identify:

- Files to change
- Existing code to reuse
- New code required
- Data model changes
- API changes
- Migration requirements
- Security implications
- Performance implications
- Rollback implications
- Observability requirements

Prefer:

```text
Small diff
→ Existing abstraction
→ Minimal surface area
→ Explicit behavior
```

Avoid combining unrelated work such as:

```text
Feature
+ large refactor
+ dependency upgrade
+ architecture rewrite
```

unless those changes are genuinely required.

---

# 6. Implement Conservatively

Implementation rules:

- Follow existing repository conventions.
- Keep functions focused.
- Keep modules cohesive.
- Avoid duplicate business logic.
- Validate inputs at boundaries.
- Handle errors explicitly.
- Preserve backward compatibility where required.
- Avoid hidden side effects.
- Avoid unnecessary dependencies.
- Avoid speculative abstractions.
- Do not expose secrets.
- Do not silently swallow failures.
- Prefer readable code over clever code.
- Make illegal states difficult or impossible to represent where practical.

AI-generated code must never be accepted merely because it compiles.

---

# 7. Break Mode

After implementing a solution, switch roles.

Assume the implementation is wrong.

Your job is now to destroy it.

For every meaningful change, deliberately inspect these failure dimensions.

## Input failures

Test:

- Null values
- Empty values
- Missing fields
- Invalid formats
- Unexpected types
- Very large inputs
- Malicious inputs
- Unicode and encoding issues where relevant

## State failures

Test:

- Missing state
- Stale state
- Corrupted state
- Duplicate state
- Unexpected previous state
- Partial state updates
- Out-of-order events

## Time failures

Test:

- Timeouts
- Slow dependencies
- Expired data
- Retry timing
- Clock skew
- Date boundaries
- Time zones
- Race windows

## Concurrency failures

Test:

- Duplicate requests
- Simultaneous writes
- Race conditions
- Lock contention
- Lost updates
- Double execution
- Re-entrant behavior

## Dependency failures

Assume any dependency can fail.

Test:

- Database unavailable
- Cache unavailable
- Queue unavailable
- External API unavailable
- API timeout
- API returns invalid data
- API returns partial data
- Dependency becomes slow
- Dependency returns success after local timeout

## Scale failures

Ask what happens with:

- 10× traffic
- 100× data
- Very large accounts
- Traffic spikes
- Hot partitions
- Large payloads
- Long-running operations
- Many concurrent users

## Security failures

Attempt to identify:

- Missing authentication
- Missing authorization
- Privilege escalation
- Injection
- Sensitive-data leakage
- Secret exposure
- Unsafe file handling
- Broken tenant isolation
- Rate-limit bypasses
- Replay attacks
- Unsafe redirects
- Trust-boundary violations

## Operational failures

Ask:

- What if deployment stops halfway?
- What if a migration partially succeeds?
- What if the process crashes after a write?
- What if retries repeat a side effect?
- Can operators identify the failure quickly?
- Can the change be rolled back safely?

---

# 8. Worst-Case Thinking

For every important feature, ask:

> What chain of events could create the worst realistic production incident?

Work backwards from that incident.

Example:

```text
Request retried
  ↓
Operation runs twice
  ↓
State changes twice
  ↓
Customer charged twice
  ↓
Refund system fails
  ↓
Support and trust impact
```

Then derive engineering protections:

```text
Idempotency
+ transactions
+ deduplication
+ audit trail
+ retry policy
+ monitoring
+ recovery path
```

Focus most effort on failures that are:

- Irreversible
- Financially harmful
- Security-sensitive
- Data-destructive
- Hard to detect
- Likely to cascade
- Difficult to recover from

Do not spend equal effort on trivial and catastrophic failures.

---

# 9. Risk Prioritization

Prioritize risks using:

```text
Risk ≈ Probability × Impact × Difficulty of Detection
```

Classify findings:

- **Critical** — data loss, security breach, financial corruption, severe outage
- **High** — major functionality failure, repeated incidents, serious degradation
- **Medium** — contained failure with manageable recovery
- **Low** — cosmetic, minor, or low-impact issue

Critical and high-risk issues must be addressed before merge unless explicitly accepted by the responsible owner.

---

# 10. Experimental Engineering Mode

Do not trust reasoning when reality can be measured.

Use:

```text
Hypothesis
  ↓
Prototype
  ↓
Test
  ↓
Measure
  ↓
Find weakness
  ↓
Improve
  ↓
Repeat
```

Replace vague claims with evidence.

Instead of:

> This should scale.

Prefer:

> Load testing at the expected peak showed acceptable latency and resource usage.

When relevant, measure:

- Latency
- Throughput
- CPU
- Memory
- Database load
- Query count
- Cache behavior
- Error rate
- Queue depth
- Retry volume
- Payload size
- Startup time

If evidence contradicts the design, change the design.

Reality wins over architecture preference.

---

# 11. Testing Requirements

Every change should be tested at the appropriate levels.

## Unit tests

Cover:

- Normal path
- Boundary cases
- Invalid input
- Failure paths
- Important branching behavior

## Integration tests

Use when behavior depends on:

- Database
- API contracts
- Queues
- Files
- Cache
- External services
- Framework integration

## Regression tests

Every bug fix should include a regression test where practical.

The regression test should:

1. Fail before the fix.
2. Pass after the fix.

## End-to-end tests

Use for critical user or system flows when lower-level tests cannot provide enough confidence.

---

# 12. Performance and Scalability Review

For changes affecting important paths, inspect:

- Database query count
- N+1 queries
- Missing indexes
- Full table scans
- Memory growth
- Unbounded collections
- CPU-heavy work
- Excessive serialization
- Repeated network calls
- Large payloads
- Poor batching
- Lock contention
- Inefficient retries
- Missing backpressure

Ask:

> What breaks first if usage increases by 10×?

Do not prematurely optimize everything, but never knowingly introduce an obviously unscalable design.

---

# 13. Reliability Review

Check whether the feature needs:

- Idempotency
- Retries
- Retry limits
- Exponential backoff
- Jitter
- Circuit breakers
- Timeouts
- Dead-letter queues
- Transaction boundaries
- Compensating actions
- Graceful degradation
- Fallback behavior
- Backpressure
- Deduplication

Never add retries without understanding whether the operation is safe to repeat.

---

# 14. Security Review

For every change, evaluate:

- Authentication
- Authorization
- Tenant isolation
- Input validation
- Output encoding
- Injection risk
- Sensitive-data handling
- Secrets
- Permissions
- File access
- Dependency trust
- Rate limiting
- Auditability

Treat all external input as untrusted.

Treat internal services as separate trust boundaries when appropriate.

---

# 15. Data and Migration Safety

For database or storage changes:

- Preserve backward compatibility during rollout.
- Avoid destructive migrations in the same step as dependent code rollout.
- Use staged migrations when necessary.
- Consider partial deployment.
- Consider old and new application versions running simultaneously.
- Define rollback behavior.

Prefer:

```text
Expand → Deploy → Migrate → Verify → Contract
```

For destructive operations, require explicit safeguards.

---

# 16. Product Simplicity Mode

A technically correct feature is not finished if it is confusing.

Ask:

- Is there one obvious path?
- Can unnecessary choices be removed?
- Are names clear?
- Are APIs predictable?
- Are defaults sensible?
- Are errors understandable?
- Can a new engineer understand the implementation quickly?
- Can the architecture be explained simply?
- Can configuration be removed?
- Can this workflow be shorter?

Good engineering reduces cognitive load.

Complexity should live inside the system, not inside the user's head.

---

# 17. Error Experience

Errors should help users and operators recover.

Good errors should answer:

- What failed?
- Why did it fail?
- Can it be retried?
- What should happen next?

Do not:

- Leak sensitive internals
- Return meaningless generic failures when actionable context is available
- Log secrets
- Hide critical errors

---

# 18. Observability

For important production behavior, ensure the system can answer:

- Did it succeed?
- Did it fail?
- Why?
- How often?
- How long did it take?
- Which dependency caused the problem?
- Which users or tenants are affected?

Use appropriate:

- Structured logs
- Metrics
- Traces
- Error tracking
- Alerts
- Audit events

Observability must be designed before incidents happen.

---

# 19. Architecture Review

Before completion, ask:

- Does this respect module boundaries?
- Is business logic in the correct layer?
- Did we create unnecessary coupling?
- Did we duplicate an abstraction?
- Did we create circular dependencies?
- Is state ownership clear?
- Are responsibilities clear?
- Does this make future change easier or harder?
- Can any layer be removed?

Prefer the simplest architecture that satisfies current requirements and known constraints.

---

# 20. Adversarial Self-Review

Before declaring the task complete, perform a second-pass review as if reviewing another engineer's work.

Assume:

- The original author misunderstood something.
- Tests may be incomplete.
- Happy-path reasoning may be hiding failures.
- Naming may hide complexity.
- The implementation may work locally but fail in production.

Specifically search for:

- Incorrect assumptions
- Silent failures
- Missing validation
- Missing permissions
- Race conditions
- Duplicate side effects
- Partial writes
- Unbounded work
- Resource leaks
- Incomplete cleanup
- Error masking
- Hidden coupling
- Over-engineering
- Under-engineering
- Dead code
- Debug code
- Unrelated changes

---

# 21. Final Diff Review

Review the final diff, not only the code you intended to write.

Check for:

- Accidental edits
- Unrelated refactors
- Dependency changes
- Configuration changes
- Missing tests
- Dead code
- Debug statements
- Temporary code
- Inconsistent naming
- Missing documentation where behavior changed

Prefer small, focused diffs.

---

# 22. Automated Quality Gates

Run all repository-required checks before completion.

Typical pipeline:

```text
Format
  ↓
Lint
  ↓
Type Check
  ↓
Unit Tests
  ↓
Integration Tests
  ↓
Security Checks
  ↓
Build
```

Do not bypass failing checks unless the reason is understood and explicitly documented.

---

# 23. Deployment Safety

For risky changes, define:

- Rollout strategy
- Feature flags
- Migration order
- Backward compatibility
- Monitoring criteria
- Rollback path
- Data recovery path

Ask:

> If this deployment fails halfway, is the system still safe?

---

# 24. Post-Deployment Validation

After release, verify:

- Expected behavior works.
- Error rates remain healthy.
- Latency remains healthy.
- Resource usage is normal.
- Database load is normal.
- Logs contain no new unexpected failures.
- Critical business metrics remain healthy.

A deployment succeeding technically does not prove the feature succeeded operationally.

---

# 25. Presentation Standard

Before presenting a solution, summarize it clearly.

Use this format when appropriate:

```text
Problem
  ↓
Root Cause / Constraint
  ↓
Solution
  ↓
Why this design
  ↓
Risks
  ↓
Tests
  ↓
Operational impact
```

The explanation should be simple enough that another engineer can understand the decision quickly.

Prefer:

- Clear diagrams
- Small tables
- Concrete examples
- Short explanations
- Explicit tradeoffs

Avoid hiding complexity behind jargon.

---

# 26. Rules for AI Coding Agents

AI agents working in this repository must follow these rules:

1. Inspect relevant code before editing.
2. Explain the existing flow before changing architecture.
3. Identify the root cause before fixing a bug.
4. Prefer the smallest safe change.
5. Reuse existing patterns before adding abstractions.
6. Never invent APIs, fields, configuration, or dependencies without verifying them.
7. Generate or update tests for changed behavior.
8. Add regression tests for bug fixes where practical.
9. Challenge assumptions before implementation.
10. Perform an explicit adversarial failure review after implementation.
11. Consider concurrency, retries, partial failure, and scale.
12. Consider authentication, authorization, and data exposure.
13. Do not perform unrelated refactors unless required.
14. Do not hide failing tests.
15. Do not silently weaken validation.
16. Do not silently remove error handling.
17. Do not introduce breaking changes without identifying them.
18. Do not claim scalability, reliability, or performance without evidence when measurement is practical.
19. Review the final diff before completion.
20. Clearly state remaining risks or uncertainty.

---

# 27. Mandatory Agent Workflow

For every non-trivial feature or bug fix, follow:

```text
1. Understand
2. Inspect repository
3. Define expected behavior
4. Challenge assumptions
5. Identify risks
6. Plan smallest safe change
7. Implement
8. Add/update tests
9. Run tests and checks
10. Enter Break Mode
11. Test worst realistic failures
12. Fix important weaknesses
13. Review security
14. Review performance/scalability
15. Simplify
16. Review final diff
17. Summarize design, tests, risks, and operational impact
```

---

# 28. Definition of Done

A change is complete only when applicable items are satisfied:

- [ ] Problem and expected behavior are understood.
- [ ] Relevant architecture was inspected.
- [ ] Acceptance criteria are clear.
- [ ] Assumptions were challenged.
- [ ] Root cause is understood for bug fixes.
- [ ] Implementation is the smallest safe change.
- [ ] Repository conventions are followed.
- [ ] Tests cover expected behavior.
- [ ] Regression test exists for the bug where practical.
- [ ] Invalid inputs are handled.
- [ ] Failure paths are handled.
- [ ] Concurrency risks were considered.
- [ ] Retry/idempotency risks were considered.
- [ ] Security impact was reviewed.
- [ ] Performance impact was reviewed.
- [ ] Scale behavior was considered.
- [ ] Data migration safety was considered.
- [ ] Observability is sufficient.
- [ ] Automated quality checks pass.
- [ ] Final diff was reviewed.
- [ ] Rollback/recovery is understood for risky changes.
- [ ] Remaining risks are stated clearly.
- [ ] The solution and tradeoffs can be explained simply.

---

# Final Principle

Do not ask only:

> Does the code work?

Ask:

```text
Can it fail?
Can it fail silently?
Can it fail twice?
Can it fail under load?
Can it corrupt data?
Can it expose data?
Can it recover?
Can we observe it?
Can we simplify it?
Can another engineer understand it?
```

The standard is not merely working software.

The standard is:

> **Simple, understandable software that remains correct when reality becomes hostile.**
