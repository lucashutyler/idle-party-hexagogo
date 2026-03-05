import type { FriendRequest } from '@idle-party-rpg/shared';

/**
 * FriendsSystem manages friend requests and confirmed friendships.
 * Friends require a request/accept flow (two-way relationship).
 * Outgoing requests are persisted per-player; incoming requests are
 * derived from other players' outgoing requests.
 */
export class FriendsSystem {
  /** Confirmed mutual friends per player. */
  private friendLists = new Map<string, Set<string>>();

  /** Outgoing requests: sender → Map<target, FriendRequest>. */
  private outgoingRequests = new Map<string, Map<string, FriendRequest>>();

  /** Incoming requests (derived index): target → Map<sender, FriendRequest>. */
  private incomingRequests = new Map<string, Map<string, FriendRequest>>();

  /** Initialize a player's friend list and outgoing requests (from save data or empty). */
  initPlayer(username: string, friends: string[] = [], outgoing: FriendRequest[] = []): void {
    this.friendLists.set(username, new Set(friends));

    const outMap = new Map<string, FriendRequest>();
    for (const req of outgoing) {
      outMap.set(req.toUsername, req);

      // Rebuild incoming index for the target
      let inMap = this.incomingRequests.get(req.toUsername);
      if (!inMap) {
        inMap = new Map();
        this.incomingRequests.set(req.toUsername, inMap);
      }
      inMap.set(req.fromUsername, req);
    }
    this.outgoingRequests.set(username, outMap);

    // Ensure incoming map exists for this player
    if (!this.incomingRequests.has(username)) {
      this.incomingRequests.set(username, new Map());
    }
  }

  /**
   * Send a friend request. Returns true on success or an error string.
   * If the target already sent a request to the sender, auto-accepts both.
   */
  sendRequest(fromUsername: string, toUsername: string): true | string {
    if (fromUsername === toUsername) return 'Cannot send a friend request to yourself';

    const friends = this.friendLists.get(fromUsername);
    if (friends?.has(toUsername)) return 'Already friends';

    const outMap = this.outgoingRequests.get(fromUsername);
    if (outMap?.has(toUsername)) return 'Friend request already sent';

    // Check if target already sent a request to us — auto-accept
    const targetOutMap = this.outgoingRequests.get(toUsername);
    if (targetOutMap?.has(fromUsername)) {
      // Auto-accept: add both as friends, clear the existing request
      this.addFriendBothWays(fromUsername, toUsername);
      this.removeRequest(toUsername, fromUsername);
      return true;
    }

    // Create the request
    const request: FriendRequest = {
      fromUsername,
      toUsername,
      timestamp: Date.now(),
    };

    // Add to outgoing
    let senderOut = this.outgoingRequests.get(fromUsername);
    if (!senderOut) {
      senderOut = new Map();
      this.outgoingRequests.set(fromUsername, senderOut);
    }
    senderOut.set(toUsername, request);

    // Add to incoming index
    let targetIn = this.incomingRequests.get(toUsername);
    if (!targetIn) {
      targetIn = new Map();
      this.incomingRequests.set(toUsername, targetIn);
    }
    targetIn.set(fromUsername, request);

    return true;
  }

  /** Accept an incoming friend request. */
  acceptRequest(username: string, fromUsername: string): true | string {
    const inMap = this.incomingRequests.get(username);
    if (!inMap?.has(fromUsername)) return 'Friend request not found';

    this.addFriendBothWays(fromUsername, username);
    this.removeRequest(fromUsername, username);
    return true;
  }

  /** Decline an incoming friend request. */
  declineRequest(username: string, fromUsername: string): true | string {
    const inMap = this.incomingRequests.get(username);
    if (!inMap?.has(fromUsername)) return 'Friend request not found';

    this.removeRequest(fromUsername, username);
    return true;
  }

  /** Revoke an outgoing friend request (sender cancels). */
  revokeRequest(fromUsername: string, toUsername: string): true | string {
    const outMap = this.outgoingRequests.get(fromUsername);
    if (!outMap?.has(toUsername)) return 'Friend request not found';

    this.removeRequest(fromUsername, toUsername);
    return true;
  }

  /** Remove a confirmed friend from both players' lists. */
  removeFriend(username: string, friendUsername: string): boolean {
    const aFriends = this.friendLists.get(username);
    const bFriends = this.friendLists.get(friendUsername);
    const removed = aFriends?.delete(friendUsername) ?? false;
    bFriends?.delete(username);
    return removed;
  }

  /** Get a player's confirmed friend list. */
  getFriends(username: string): string[] {
    const friends = this.friendLists.get(username);
    return friends ? Array.from(friends) : [];
  }

  /** Get a player's outgoing (sent) friend requests. */
  getOutgoingRequests(username: string): FriendRequest[] {
    const outMap = this.outgoingRequests.get(username);
    return outMap ? Array.from(outMap.values()) : [];
  }

  /** Get a player's incoming (received) friend requests. */
  getIncomingRequests(username: string): FriendRequest[] {
    const inMap = this.incomingRequests.get(username);
    return inMap ? Array.from(inMap.values()) : [];
  }

  /** Check if two players are confirmed mutual friends. */
  areMutualFriends(a: string, b: string): boolean {
    const aFriends = this.friendLists.get(a);
    return aFriends?.has(b) ?? false;
  }

  /** Remove a player's data (on account deletion). */
  removePlayer(username: string): void {
    // Remove from all friend lists
    const friends = this.friendLists.get(username);
    if (friends) {
      for (const f of friends) {
        this.friendLists.get(f)?.delete(username);
      }
    }
    this.friendLists.delete(username);

    // Remove outgoing requests (and their incoming index entries)
    const outMap = this.outgoingRequests.get(username);
    if (outMap) {
      for (const target of outMap.keys()) {
        this.incomingRequests.get(target)?.delete(username);
      }
    }
    this.outgoingRequests.delete(username);

    // Remove incoming requests (and their outgoing entries)
    const inMap = this.incomingRequests.get(username);
    if (inMap) {
      for (const sender of inMap.keys()) {
        this.outgoingRequests.get(sender)?.delete(username);
      }
    }
    this.incomingRequests.delete(username);
  }

  /** Add both players to each other's friend lists. */
  private addFriendBothWays(a: string, b: string): void {
    let aFriends = this.friendLists.get(a);
    if (!aFriends) {
      aFriends = new Set();
      this.friendLists.set(a, aFriends);
    }
    aFriends.add(b);

    let bFriends = this.friendLists.get(b);
    if (!bFriends) {
      bFriends = new Set();
      this.friendLists.set(b, bFriends);
    }
    bFriends.add(a);
  }

  /** Remove a request from both outgoing and incoming indexes. */
  private removeRequest(fromUsername: string, toUsername: string): void {
    this.outgoingRequests.get(fromUsername)?.delete(toUsername);
    this.incomingRequests.get(toUsername)?.delete(fromUsername);
  }
}
