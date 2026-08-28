import { OwnershipLostFault } from "../../domain/ownership";

export class StoreSecurityError extends Error {
  override readonly name = "StoreSecurityError";
}

export class StoreIntegrityError extends Error {
  override readonly name = "StoreIntegrityError";
}

export class OwnershipUnavailableError extends OwnershipLostFault {
  override readonly name = "OwnershipUnavailableError";
}
