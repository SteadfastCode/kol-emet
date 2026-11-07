/**
 * The one invariant a workspace cannot be allowed to lose: it holds an owner.
 *
 * Both halves live here rather than in routes/workspace.js because both are
 * parts of a *write* — a filter and an update-pipeline stage — and because an
 * invariant that is only ever expressed inline is an invariant the next write
 * to touch `members` will express differently. `lib/accountDeleter.js` reads
 * `ownerId` to judge sole ownership, so these two are what keep that question
 * answerable.
 */

/**
 * The last-owner floor, as the write's own filter (KOL-134).
 *
 * The floor used to be an `if` in front of the write: read the members array,
 * count the owners, refuse at one, then `updateOne`. Read-then-write, so with
 * two owners **two** concurrent demotions each read two owners, each passed the
 * count, and both landed — leaving a workspace with nobody holding `owner`.
 * That state is permanent: a role change and an invite are both
 * `requireWorkspaceRole('owner')`, so nothing in the product could ever mint an
 * owner there again, and the workspace could never be renamed, invited into or
 * managed.
 *
 * So the invariant moved into the condition the write itself is matched on:
 * *this workspace still holds an owner who is not this member*. MongoDB
 * evaluates it against the document as it stands at the moment of the write, so
 * the second of two racing demotions finds the first already landed and matches
 * nothing. **No match is the 409** — the refusal and the check are one
 * operation, and there is no window between them to lose.
 *
 * `memberId` must be the stored ObjectId, not a request string: `$expr` is an
 * aggregation expression and Mongoose does not cast inside one, so a string
 * would be `$ne` to every member and the floor would never hold.
 *
 * (A workspace deleted between the read and the write also matches nothing, and
 * is reported as the refusal. Telling the two apart would mean a second read
 * whose answer could be stale again, to change one status code on a path where
 * nothing was written either way.)
 */
export const anotherOwnerThan = (memberId) => ({
  $expr: {
    $gte: [{
      $size: {
        $filter: {
          input: { $ifNull: ['$members', []] },
          as: 'm',
          cond: { $and: [{ $eq: ['$$m.role', 'owner'] }, { $ne: ['$$m.userId', memberId] }] },
        },
      },
    }, 1],
  },
});

/**
 * Keeps `Workspace.ownerId` naming a member who holds the owner role.
 *
 * `ownerId` is a separate field from the `members` array, and it is what
 * account deletion judges sole ownership by. Left alone, demoting or removing
 * the user it names would leave it pointing at a non-owner — or at someone who
 * is not a member at all, whose own account could then never be deleted
 * (lib/accountDeleter.js would see a workspace they "own" but do not solely
 * own, and refuse). So it moves to another owner.
 *
 * An update-pipeline stage rather than a value a route computes from its own
 * read, for the same reason the floor is a filter: it reads `$members` as the
 * stage before it just left them — so it must run *after* the stage that
 * changes them — and the id it picks is therefore derived from the array the
 * write actually produced, never from a conclusion drawn before it.
 * With three owners the stale version was wrong — two concurrent demotions of
 * two *different* owners both legitimately land, and the second one's pre-write
 * array still showed the first demoted owner holding the role, so `ownerId`
 * was left naming them.
 *
 * Unchanged when the holder is still an owner, and unchanged when no member
 * holds the role at all: a workspace with no owner is not a state these routes
 * can produce, and clearing `ownerId` in one would only make it less repairable.
 */
export const MOVE_OWNER_ID_TO_AN_OWNER = {
  $set: {
    ownerId: {
      $let: {
        vars: { owners: { $filter: { input: '$members', as: 'm', cond: { $eq: ['$$m.role', 'owner'] } } } },
        in: {
          $cond: [
            { $in: ['$ownerId', '$$owners.userId'] },
            '$ownerId',
            { $ifNull: [{ $arrayElemAt: ['$$owners.userId', 0] }, '$ownerId'] },
          ],
        },
      },
    },
  },
};
