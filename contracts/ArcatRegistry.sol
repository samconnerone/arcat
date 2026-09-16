// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArcatRegistry
/// @notice On-chain record of Arcat verifications for the Arc ecosystem.
///         Arcat publishes attestations here so any wallet, app, or agent on
///         Arc can read — directly from the chain — whether a project or builder
///         has been verified, and at what trust tier, without having to trust
///         Arcat's website or API.
///
///         This is Arcat's *opinion*, signed on-chain — not decentralized
///         truth. Only authorized attesters can write; the owner manages them.
contract ArcatRegistry {
    /// @notice Owner can add/remove attesters and transfer ownership.
    address public owner;

    /// @notice Addresses allowed to write attestations (the deployer + any the
    ///         owner authorizes). Kept separate from any wallet that holds funds.
    mapping(address => bool) public attester;

    struct Attestation {
        uint8  tier;      // 0 none · 1 listed · 2 claimed · 3 vetted · 4 verified · 5 arc partner · 6 arc official
        uint64 issuedAt;  // unix seconds (0 = never attested)
        bool   revoked;
        string ref;       // pointer, e.g. "ecosystem/<slug>" or an IPFS hash
    }

    /// @notice subject (a project contract or builder wallet) => its attestation.
    mapping(address => Attestation) public attestations;

    event Attested(address indexed subject, uint8 tier, string ref, address indexed by);
    event Revoked(address indexed subject, address indexed by);
    event AttesterSet(address indexed who, bool allowed);
    event OwnerTransferred(address indexed from, address indexed to);

    modifier onlyOwner()    { require(msg.sender == owner, "not owner"); _; }
    modifier onlyAttester() { require(attester[msg.sender], "not attester"); _; }

    constructor() {
        owner = msg.sender;
        attester[msg.sender] = true;
        emit OwnerTransferred(address(0), msg.sender);
        emit AttesterSet(msg.sender, true);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setAttester(address who, bool allowed) external onlyOwner {
        require(who != address(0), "zero");
        attester[who] = allowed;
        emit AttesterSet(who, allowed);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero");
        emit OwnerTransferred(owner, to);
        owner = to;
    }

    // ── Attestations ───────────────────────────────────────────────────────────

    /// @notice Publish or update Arcat's verification for `subject`.
    /// @param subject The project contract address (or builder wallet) being attested.
    /// @param tier    0 none · 1 listed · 2 verified · 3 audited.
    /// @param ref     A human/agent-readable pointer to the evidence (URL or IPFS hash).
    function attest(address subject, uint8 tier, string calldata ref) external onlyAttester {
        require(subject != address(0), "zero subject");
        require(tier <= 6, "bad tier");
        attestations[subject] = Attestation({
            tier:     tier,
            issuedAt: uint64(block.timestamp),
            revoked:  false,
            ref:      ref
        });
        emit Attested(subject, tier, ref, msg.sender);
    }

    /// @notice Revoke a verification (e.g. a project was delisted or turned malicious).
    function revoke(address subject) external onlyAttester {
        Attestation storage a = attestations[subject];
        require(a.issuedAt != 0, "not found");
        a.revoked = true;
        emit Revoked(subject, msg.sender);
    }

    // ── Reads (for wallets, apps, agents) ───────────────────────────────────────

    /// @notice True if `subject` is currently Verified or higher (tier >= 4, not revoked).
    function isVerified(address subject) external view returns (bool) {
        Attestation storage a = attestations[subject];
        return a.issuedAt != 0 && !a.revoked && a.tier >= 4;
    }

    /// @notice Full attestation for `subject` in one call.
    function get(address subject)
        external
        view
        returns (uint8 tier, uint64 issuedAt, bool revoked, string memory ref)
    {
        Attestation storage a = attestations[subject];
        return (a.tier, a.issuedAt, a.revoked, a.ref);
    }
}
