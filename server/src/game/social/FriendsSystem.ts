/**
 * FriendsSystem manages per-player friend lists.
 * Friends are added instantly (no request flow) and stored per-player.
 * Each player maintains their own list independently.
 */
export class FriendsSystem {
  private friendLists = new Map<string, Set<string>>();

  /** Initialize a player's friend list (from save data or empty). */
  initPlayer(username: string, friends: string[] = []): void {
    this.friendLists.set(username, new Set(friends));
  }

  /** Add a friend to a player's list. Returns true if newly added. */
  addFriend(username: string, friendUsername: string): boolean {
    if (username === friendUsername) return false;

    let friends = this.friendLists.get(username);
    if (!friends) {
      friends = new Set();
      this.friendLists.set(username, friends);
    }

    if (friends.has(friendUsername)) return false;
    friends.add(friendUsername);
    return true;
  }

  /** Remove a friend from a player's list. Returns true if removed. */
  removeFriend(username: string, friendUsername: string): boolean {
    const friends = this.friendLists.get(username);
    if (!friends) return false;
    return friends.delete(friendUsername);
  }

  /** Get a player's friend list as an array. */
  getFriends(username: string): string[] {
    const friends = this.friendLists.get(username);
    return friends ? Array.from(friends) : [];
  }

  /** Check if two players are mutual friends. */
  areMutualFriends(a: string, b: string): boolean {
    const aFriends = this.friendLists.get(a);
    const bFriends = this.friendLists.get(b);
    return (aFriends?.has(b) ?? false) && (bFriends?.has(a) ?? false);
  }

  /** Remove a player's data (on account deletion). */
  removePlayer(username: string): void {
    this.friendLists.delete(username);
  }
}
