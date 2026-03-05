import { describe, it, expect, beforeEach } from 'vitest';
import { FriendsSystem } from '../src/game/social/FriendsSystem.js';

describe('FriendsSystem', () => {
  let system: FriendsSystem;

  beforeEach(() => {
    system = new FriendsSystem();
    system.initPlayer('alice');
    system.initPlayer('bob');
    system.initPlayer('charlie');
  });

  describe('sendRequest', () => {
    it('creates a pending request', () => {
      expect(system.sendRequest('alice', 'bob')).toBe(true);
      expect(system.getOutgoingRequests('alice')).toHaveLength(1);
      expect(system.getOutgoingRequests('alice')[0].toUsername).toBe('bob');
      expect(system.getIncomingRequests('bob')).toHaveLength(1);
      expect(system.getIncomingRequests('bob')[0].fromUsername).toBe('alice');
    });

    it('rejects self-request', () => {
      expect(system.sendRequest('alice', 'alice')).toBe('Cannot send a friend request to yourself');
    });

    it('rejects duplicate request', () => {
      system.sendRequest('alice', 'bob');
      expect(system.sendRequest('alice', 'bob')).toBe('Friend request already sent');
    });

    it('rejects if already friends', () => {
      system.sendRequest('alice', 'bob');
      system.acceptRequest('bob', 'alice');
      expect(system.sendRequest('alice', 'bob')).toBe('Already friends');
    });

    it('auto-accepts cross-requests', () => {
      system.sendRequest('alice', 'bob');
      expect(system.sendRequest('bob', 'alice')).toBe(true);
      // Both should be friends now
      expect(system.areMutualFriends('alice', 'bob')).toBe(true);
      // No pending requests remain
      expect(system.getOutgoingRequests('alice')).toHaveLength(0);
      expect(system.getOutgoingRequests('bob')).toHaveLength(0);
      expect(system.getIncomingRequests('alice')).toHaveLength(0);
      expect(system.getIncomingRequests('bob')).toHaveLength(0);
    });
  });

  describe('acceptRequest', () => {
    it('adds both to friend lists and removes request', () => {
      system.sendRequest('alice', 'bob');
      expect(system.acceptRequest('bob', 'alice')).toBe(true);
      expect(system.areMutualFriends('alice', 'bob')).toBe(true);
      expect(system.getOutgoingRequests('alice')).toHaveLength(0);
      expect(system.getIncomingRequests('bob')).toHaveLength(0);
    });

    it('rejects non-existent request', () => {
      expect(system.acceptRequest('bob', 'alice')).toBe('Friend request not found');
    });
  });

  describe('declineRequest', () => {
    it('removes the request', () => {
      system.sendRequest('alice', 'bob');
      expect(system.declineRequest('bob', 'alice')).toBe(true);
      expect(system.getOutgoingRequests('alice')).toHaveLength(0);
      expect(system.getIncomingRequests('bob')).toHaveLength(0);
      expect(system.areMutualFriends('alice', 'bob')).toBe(false);
    });

    it('rejects non-existent request', () => {
      expect(system.declineRequest('bob', 'alice')).toBe('Friend request not found');
    });
  });

  describe('revokeRequest', () => {
    it('removes outgoing request', () => {
      system.sendRequest('alice', 'bob');
      expect(system.revokeRequest('alice', 'bob')).toBe(true);
      expect(system.getOutgoingRequests('alice')).toHaveLength(0);
      expect(system.getIncomingRequests('bob')).toHaveLength(0);
    });

    it('rejects non-existent request', () => {
      expect(system.revokeRequest('alice', 'bob')).toBe('Friend request not found');
    });
  });

  describe('removeFriend', () => {
    it('removes from both players (symmetric)', () => {
      system.sendRequest('alice', 'bob');
      system.acceptRequest('bob', 'alice');
      expect(system.removeFriend('alice', 'bob')).toBe(true);
      expect(system.areMutualFriends('alice', 'bob')).toBe(false);
      expect(system.getFriends('alice')).toHaveLength(0);
      expect(system.getFriends('bob')).toHaveLength(0);
    });

    it('returns false if not friends', () => {
      expect(system.removeFriend('alice', 'bob')).toBe(false);
    });
  });

  describe('initPlayer', () => {
    it('restores confirmed friends', () => {
      const sys = new FriendsSystem();
      sys.initPlayer('alice', ['bob']);
      sys.initPlayer('bob', ['alice']);
      expect(sys.areMutualFriends('alice', 'bob')).toBe(true);
    });

    it('restores outgoing requests and rebuilds incoming index', () => {
      const sys = new FriendsSystem();
      sys.initPlayer('alice', [], [{ fromUsername: 'alice', toUsername: 'bob', timestamp: 1000 }]);
      sys.initPlayer('bob');
      // alice has outgoing, bob has incoming
      expect(sys.getOutgoingRequests('alice')).toHaveLength(1);
      expect(sys.getIncomingRequests('bob')).toHaveLength(1);
      expect(sys.getIncomingRequests('bob')[0].fromUsername).toBe('alice');
    });
  });

  describe('removePlayer', () => {
    it('cleans up all related data', () => {
      system.sendRequest('alice', 'bob');
      system.sendRequest('charlie', 'alice');
      system.removePlayer('alice');
      // Bob should have no incoming from alice
      expect(system.getIncomingRequests('bob')).toHaveLength(0);
      // Charlie should have no outgoing to alice
      expect(system.getOutgoingRequests('charlie')).toHaveLength(0);
    });
  });
});
