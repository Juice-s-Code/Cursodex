/** Validate the configured project-local agent identity without coercion. */
const actorPattern = /^[a-z][a-z0-9_-]{0,63}$/;

export function isValidActorSlug(value) {
  return typeof value === 'string' && value.length <= 64 && actorPattern.test(value) &&
    actorPattern.exec(value)?.[0] === value;
}

// Named for callers that prefer validation-oriented imports; this is a pure
// predicate and never normalizes or grants authority to the supplied name.
export const validateActorSlug = isValidActorSlug;
