// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v1.178.0
//   protoc               unknown
// source: sedachain/vesting/v1/vesting.proto

/* eslint-disable */
import _m0 from "protobufjs/minimal.js";
import { ContinuousVestingAccount } from "../../../cosmos/vesting/v1beta1/vesting.js";

/**
 * ClawbackContinuousVestingAccount implements the VestingAccount interface.
 * It wraps a ContinuousVestingAccount provided by Cosmos SDK to provide
 * additional support for clawback.
 */
export interface ClawbackContinuousVestingAccount {
  baseVestingAccount: ContinuousVestingAccount | undefined;
  funderAddress: string;
}

function createBaseClawbackContinuousVestingAccount(): ClawbackContinuousVestingAccount {
  return { baseVestingAccount: undefined, funderAddress: "" };
}

export const ClawbackContinuousVestingAccount = {
  encode(message: ClawbackContinuousVestingAccount, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.baseVestingAccount !== undefined) {
      ContinuousVestingAccount.encode(message.baseVestingAccount, writer.uint32(10).fork()).ldelim();
    }
    if (message.funderAddress !== "") {
      writer.uint32(18).string(message.funderAddress);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ClawbackContinuousVestingAccount {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseClawbackContinuousVestingAccount();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.baseVestingAccount = ContinuousVestingAccount.decode(reader, reader.uint32());
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.funderAddress = reader.string();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ClawbackContinuousVestingAccount {
    return {
      baseVestingAccount: isSet(object.baseVestingAccount)
        ? ContinuousVestingAccount.fromJSON(object.baseVestingAccount)
        : undefined,
      funderAddress: isSet(object.funderAddress) ? globalThis.String(object.funderAddress) : "",
    };
  },

  toJSON(message: ClawbackContinuousVestingAccount): unknown {
    const obj: any = {};
    if (message.baseVestingAccount !== undefined) {
      obj.baseVestingAccount = ContinuousVestingAccount.toJSON(message.baseVestingAccount);
    }
    if (message.funderAddress !== "") {
      obj.funderAddress = message.funderAddress;
    }
    return obj;
  },

  create(base?: DeepPartial<ClawbackContinuousVestingAccount>): ClawbackContinuousVestingAccount {
    return ClawbackContinuousVestingAccount.fromPartial(base ?? {});
  },
  fromPartial(object: DeepPartial<ClawbackContinuousVestingAccount>): ClawbackContinuousVestingAccount {
    const message = createBaseClawbackContinuousVestingAccount();
    message.baseVestingAccount = (object.baseVestingAccount !== undefined && object.baseVestingAccount !== null)
      ? ContinuousVestingAccount.fromPartial(object.baseVestingAccount)
      : undefined;
    message.funderAddress = object.funderAddress ?? "";
    return message;
  },
};

type Builtin = Date | Function | Uint8Array | string | number | boolean | undefined;

type DeepPartial<T> = T extends Builtin ? T
  : T extends globalThis.Array<infer U> ? globalThis.Array<DeepPartial<U>>
  : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>>
  : T extends {} ? { [K in keyof T]?: DeepPartial<T[K]> }
  : Partial<T>;

function isSet(value: any): boolean {
  return value !== null && value !== undefined;
}
