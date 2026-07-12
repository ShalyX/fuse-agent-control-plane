// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Fuse Arc Spend Mandate
/// @notice Anchors a session-level maximum and one final receipt-bundle commitment.
/// @dev Per-completion metering, payments, and circuit enforcement remain off-chain.
contract FuseSpendMandate {
    struct Mandate {
        address controller;
        uint256 maximumSpendAtomic;
        uint256 totalPaidAtomic;
        bytes32 receiptHash;
        uint64 openedAt;
        uint64 closedAt;
    }

    mapping(bytes32 mandateId => Mandate mandate) public mandates;

    event MandateOpened(
        bytes32 indexed mandateId,
        address indexed controller,
        uint256 maximumSpendAtomic
    );

    event MandateClosed(
        bytes32 indexed mandateId,
        uint256 totalPaidAtomic,
        bytes32 indexed receiptHash
    );

    error InvalidMandateId();
    error InvalidController();
    error InvalidMaximumSpend();
    error MandateAlreadyExists();
    error MandateNotFound();
    error UnauthorizedController();
    error MandateAlreadyClosed();
    error SpendExceedsMandate();
    error InvalidReceiptHash();

    function openMandate(
        bytes32 mandateId,
        uint256 maximumSpendAtomic,
        address controller
    ) external {
        if (mandateId == bytes32(0)) revert InvalidMandateId();
        if (controller == address(0)) revert InvalidController();
        if (maximumSpendAtomic == 0) revert InvalidMaximumSpend();
        if (mandates[mandateId].controller != address(0)) revert MandateAlreadyExists();

        mandates[mandateId] = Mandate({
            controller: controller,
            maximumSpendAtomic: maximumSpendAtomic,
            totalPaidAtomic: 0,
            receiptHash: bytes32(0),
            openedAt: uint64(block.timestamp),
            closedAt: 0
        });

        emit MandateOpened(mandateId, controller, maximumSpendAtomic);
    }

    function closeMandate(
        bytes32 mandateId,
        uint256 totalPaidAtomic,
        bytes32 receiptHash
    ) external {
        Mandate storage mandate = mandates[mandateId];
        if (mandate.controller == address(0)) revert MandateNotFound();
        if (msg.sender != mandate.controller) revert UnauthorizedController();
        if (mandate.closedAt != 0) revert MandateAlreadyClosed();
        if (totalPaidAtomic > mandate.maximumSpendAtomic) revert SpendExceedsMandate();
        if (receiptHash == bytes32(0)) revert InvalidReceiptHash();

        mandate.totalPaidAtomic = totalPaidAtomic;
        mandate.receiptHash = receiptHash;
        mandate.closedAt = uint64(block.timestamp);

        emit MandateClosed(mandateId, totalPaidAtomic, receiptHash);
    }
}
