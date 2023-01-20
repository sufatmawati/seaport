import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { keccak256, recoverAddress, toUtf8Bytes } from "ethers/lib/utils";
import hre, { ethers, network } from "hardhat";

import {
  ERC165__factory,
  SIP5Interface__factory,
  ZoneInterface__factory,
} from "../../typechain-types";
import { merkleTree } from "../utils/criteria";
import {
  buildResolver,
  convertSignatureToEIP2098,
  getInterfaceID,
  getItemETH,
  randomHex,
  toBN,
  toKey,
} from "../utils/encoding";
import { faucet } from "../utils/faucet";
import { seaportFixture } from "../utils/fixtures";
import {
  VERSION,
  changeChainId,
  getCustomRevertSelector,
} from "../utils/helpers";

import type {
  ConsiderationInterface,
  SignedZone,
  SignedZone__factory,
} from "../../typechain-types";
import type { SeaportFixtures } from "../utils/fixtures";
import type { Contract, Wallet } from "ethers";

const { signedOrderType } = require("../../eip-712-types/signedOrder");

const { parseEther } = ethers.utils;

describe(`Zone - SignedZone (Seaport v${VERSION})`, function () {
  if (process.env.REFERENCE) return;

  const { provider } = ethers;
  const owner = new ethers.Wallet(randomHex(32), provider);

  let marketplaceContract: ConsiderationInterface;
  let signedZoneFactory: SignedZone__factory;
  let signedZone: SignedZone;

  let checkExpectedEvents: SeaportFixtures["checkExpectedEvents"];
  let createOrder: SeaportFixtures["createOrder"];
  let getTestItem721: SeaportFixtures["getTestItem721"];
  let getTestItem721WithCriteria: SeaportFixtures["getTestItem721WithCriteria"];
  let mintAndApprove721: SeaportFixtures["mintAndApprove721"];
  let withBalanceChecks: SeaportFixtures["withBalanceChecks"];

  after(async () => {
    await network.provider.request({
      method: "hardhat_reset",
    });
  });

  before(async () => {
    await faucet(owner.address, provider);

    ({
      checkExpectedEvents,
      createOrder,
      getTestItem721,
      getTestItem721WithCriteria,
      marketplaceContract,
      mintAndApprove721,
      withBalanceChecks,
    } = await seaportFixture(owner));
  });

  let buyer: Wallet;
  let seller: Wallet;

  let approvedSigner: Wallet;
  let chainId: number;

  beforeEach(async () => {
    // Setup basic buyer/seller wallets with ETH
    seller = new ethers.Wallet(randomHex(32), provider);
    buyer = new ethers.Wallet(randomHex(32), provider);

    for (const wallet of [seller, buyer]) {
      await faucet(wallet.address, provider);
    }

    approvedSigner = new ethers.Wallet(randomHex(32), provider);
    chainId = (await provider.getNetwork()).chainId;

    signedZoneFactory = await ethers.getContractFactory("SignedZone", owner);
    signedZone = await signedZoneFactory.deploy(
      "OpenSeaSignedZone",
      "https://api.opensea.io/api/v2/sign"
    );
  });

  const toPaddedBytes = (value: number, numBytes = 32) =>
    ethers.BigNumber.from(value)
      .toHexString()
      .slice(2)
      .padStart(numBytes * 2, "0");

  const calculateSignedOrderHash = (
    fulfiller: string,
    expiration: number,
    orderHash: string,
    context: string
  ) => {
    const signedOrderTypeString =
      "SignedOrder(address fulfiller,uint64 expiration,bytes32 orderHash,bytes context)";
    const signedOrderTypeHash = keccak256(toUtf8Bytes(signedOrderTypeString));

    const signedOrderHash = keccak256(
      "0x" +
        [
          signedOrderTypeHash.slice(2),
          fulfiller.slice(2).padStart(64, "0"),
          toPaddedBytes(expiration),
          orderHash.slice(2),
          keccak256(context).slice(2),
        ].join("")
    );

    return signedOrderHash;
  };

  const signOrder = async (
    orderHash: string,
    context: string = "0x",
    signer: Wallet,
    fulfiller = ethers.constants.AddressZero,
    secondsUntilExpiration = 60,
    zone: Contract = signedZone
  ) => {
    const domainData = {
      name: "SignedZone",
      version: "1.0",
      chainId,
      verifyingContract: zone.address,
    };

    const expiration = Math.round(Date.now() / 1000) + secondsUntilExpiration;
    const signedOrder = { fulfiller, expiration, orderHash, context };
    let signature = await signer._signTypedData(
      domainData,
      signedOrderType,
      signedOrder
    );

    signature = convertSignatureToEIP2098(signature);
    expect(signature.length).to.eq(2 + 64 * 2); // 0x + 64 bytes

    const { domainSeparator } = await zone.sip7Information();
    const signedOrderHash = calculateSignedOrderHash(
      fulfiller,
      expiration,
      orderHash,
      context
    );
    const digest = keccak256(
      `0x1901${domainSeparator.slice(2)}${signedOrderHash.slice(2)}`
    );

    const recoveredAddress = recoverAddress(digest, signature);
    expect(recoveredAddress).to.equal(signer.address);

    // extraData to be set on the order, according to SIP-7
    const extraData = `0x${fulfiller.slice(2)}${toPaddedBytes(
      expiration,
      8
    )}${signature.slice(2)}${context.slice(2)}`;

    return { signature, expiration, extraData };
  };

  it("Fulfills an order with a signed zone", async () => {
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    order.extraData = (
      await signOrder(orderHash, "0x1234", approvedSigner)
    ).extraData;

    // Expect failure if signer is not approved
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "SignerNotActive")
      .withArgs(approvedSigner.address, orderHash);

    // Approve signer
    await signedZone.addSigner(approvedSigner.address);

    // Expect success now that signer is approved
    await withBalanceChecks([order], 0, undefined, async () => {
      const tx = await marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        );

      const receipt = await tx.wait();
      await checkExpectedEvents(tx, receipt, [
        {
          order,
          orderHash,
          fulfiller: buyer.address,
          fulfillerConduitKey: toKey(0),
        },
      ]);
      return receipt;
    });
  });
  it("Fulfills an order with a signed zone for a specific fulfiller only", async () => {
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    order.extraData = (
      await signOrder(orderHash, undefined, approvedSigner, buyer.address)
    ).extraData;

    // Approve signer
    await signedZone.addSigner(approvedSigner.address);

    // Expect failure if fulfiller does not match
    await expect(
      marketplaceContract
        .connect(owner)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "InvalidFulfiller")
      .withArgs(buyer.address, owner.address, orderHash);

    // Expect success with correct fulfiller
    await withBalanceChecks([order], 0, undefined, async () => {
      const tx = await marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        );

      const receipt = await tx.wait();
      await checkExpectedEvents(tx, receipt, [
        {
          order,
          orderHash,
          fulfiller: buyer.address,
          fulfillerConduitKey: toKey(0),
        },
      ]);
      return receipt;
    });
  });
  it("Fulfills an advanced order with criteria with a signed zone", async () => {
    // Create advanced order using signed zone
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const { root, proofs } = merkleTree([nftId]);

    const offer = [getTestItem721WithCriteria(root, toBN(1), toBN(1))];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const criteriaResolvers = [
      buildResolver(0, 0, 0, nftId, proofs[nftId.toString()]),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2, // FULL_RESTRICTED
      criteriaResolvers
    );

    order.extraData = (
      await signOrder(orderHash, undefined, approvedSigner)
    ).extraData;

    // Expect failure if signer is not approved
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          criteriaResolvers,
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "SignerNotActive")
      .withArgs(approvedSigner.address, orderHash);

    // Approve signer
    await signedZone.addSigner(approvedSigner.address);

    await withBalanceChecks([order], 0, criteriaResolvers, async () => {
      const tx = await marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          criteriaResolvers,
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        );

      const receipt = await tx.wait();
      await checkExpectedEvents(
        tx,
        receipt,
        [
          {
            order,
            orderHash,
            fulfiller: buyer.address,
            fulfillerConduitKey: toKey(0),
          },
        ],
        undefined,
        criteriaResolvers
      );
      return receipt;
    });
  });
  it("Does not fulfill an expired signature order with a signed zone", async () => {
    // Create advanced order using signed zone
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    // Approve signer
    await signedZone.addSigner(approvedSigner.address);

    const { extraData, expiration } = await signOrder(
      orderHash,
      undefined,
      approvedSigner,
      undefined,
      -1000
    );
    order.extraData = extraData;

    // Expect failure that signature is expired
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "SignatureExpired")
      .withArgs(expiration, orderHash);

    // Tamper with extraData by extending the expiration
    order.extraData =
      order.extraData.slice(0, 50) + "9" + order.extraData.slice(51);

    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "SignerNotActive")
      .withArgs(anyValue, orderHash);
  });
  it("Only the owner can set and remove signers", async () => {
    await expect(
      signedZone.connect(buyer).addSigner(buyer.address)
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(
      signedZone.connect(buyer).removeSigner(buyer.address)
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(signedZone.connect(owner).addSigner(approvedSigner.address))
      .to.emit(signedZone, "SignerAdded")
      .withArgs(approvedSigner.address);

    await expect(signedZone.connect(owner).addSigner(approvedSigner.address))
      .to.be.revertedWithCustomError(signedZone, "SignerAlreadyAdded")
      .withArgs(approvedSigner.address);

    await expect(signedZone.connect(owner).removeSigner(approvedSigner.address))
      .to.emit(signedZone, "SignerRemoved")
      .withArgs(approvedSigner.address);

    await expect(signedZone.connect(owner).addSigner(approvedSigner.address))
      .to.be.revertedWithCustomError(signedZone, "SignerCannotBeReauthorized")
      .withArgs(approvedSigner.address);

    await expect(signedZone.connect(owner).removeSigner(approvedSigner.address))
      .to.be.revertedWithCustomError(signedZone, "SignerNotPresent")
      .withArgs(approvedSigner.address);

    await expect(
      signedZone.connect(owner).addSigner(ethers.constants.AddressZero)
    ).to.be.revertedWithCustomError(signedZone, "SignerCannotBeZeroAddress");

    await expect(
      signedZone.connect(owner).removeSigner(ethers.constants.AddressZero)
    )
      .to.be.revertedWithCustomError(signedZone, "SignerNotPresent")
      .withArgs(ethers.constants.AddressZero);
  });
  it("Only the owner should be able to modify the apiEndpoint", async () => {
    expect((await signedZone.sip7Information())[1]).to.equal(
      "https://api.opensea.io/api/v2/sign"
    );

    await expect(
      signedZone.connect(buyer).updateAPIEndpoint("test123")
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await signedZone.connect(owner).updateAPIEndpoint("test123");

    expect((await signedZone.sip7Information())[1]).to.eq("test123");
  });
  it("Should return valid data in sip7Information() and getSeaportMetadata()", async () => {
    const information = await signedZone.sip7Information();
    expect(information[0].length).to.eq(66);
    expect(information[1]).to.eq("https://api.opensea.io/api/v2/sign");

    const seaportMetadata = await signedZone.getSeaportMetadata();
    expect(seaportMetadata[0]).to.eq("OpenSeaSignedZone");
    expect(seaportMetadata[1][0][0]).to.deep.eq(toBN(7));
  });
  it("Should error on improperly formatted extraData", async () => {
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    const validExtraData = (
      await signOrder(orderHash, "0x1234", approvedSigner)
    ).extraData;

    // Approve signer
    await signedZone.addSigner(approvedSigner.address);

    // Expect failure with 0 length extraData
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "InvalidExtraData")
      .withArgs("extraData is empty", orderHash);

    // Expect failure with invalid length extraData
    order.extraData = validExtraData.slice(0, 50);
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "InvalidExtraData")
      .withArgs("extraData length must be at least 92 bytes", orderHash);

    // Expect success with valid extraData
    order.extraData = validExtraData;
    await marketplaceContract
      .connect(buyer)
      .fulfillAdvancedOrder(order, [], toKey(0), ethers.constants.AddressZero, {
        value,
      });
  });
  it("Should return supportsInterface=true for SIP-5 and ZoneInterface", async () => {
    const supportedInterfacesSIP5Interface = [[SIP5Interface__factory]];
    const supportedInterfacesZoneInterface = [[ZoneInterface__factory]];
    const supportedInterfacesERC165 = [[ERC165__factory]];

    for (const factories of [
      ...supportedInterfacesSIP5Interface,
      ...supportedInterfacesZoneInterface,
      ...supportedInterfacesERC165,
    ]) {
      const interfaceId = factories
        .map((factory) => getInterfaceID(factory.createInterface()))
        .reduce((prev, curr) => prev.xor(curr))
        .toHexString();
      expect(await signedZone.supportsInterface(interfaceId)).to.be.true;
    }

    // Ensure the interface for SIP-5 returns true.
    expect(await signedZone.supportsInterface("0x2e778efc")).to.be.true;

    // Ensure invalid interfaces return false.
    const invalidInterfaceIds = ["0x00000000", "0x10000000", "0x00000001"];
    for (const interfaceId of invalidInterfaceIds) {
      expect(await signedZone.supportsInterface(interfaceId)).to.be.false;
    }
  });
  // Note: Run this test last in this file as it hacks changing the hre
  it("Reverts on changed chainId", async () => {
    // Create advanced order using signed zone
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    order.extraData = (
      await signOrder(orderHash, undefined, approvedSigner)
    ).extraData;

    // Expect failure if signer is not approved
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "SignerNotActive")
      .withArgs(approvedSigner.address, orderHash);

    // Approve signer
    await signedZone.addSigner(approvedSigner.address);

    // Change chainId in-flight to test branch coverage for _deriveDomainSeparator()
    // (hacky way, until https://github.com/NomicFoundation/hardhat/issues/3074 is added)
    changeChainId(hre);

    const expectedRevertReason = getCustomRevertSelector("InvalidSigner()");

    const tx = await marketplaceContract
      .connect(buyer)
      .populateTransaction.fulfillAdvancedOrder(
        order,
        [],
        toKey(0),
        ethers.constants.AddressZero,
        {
          value,
        }
      );
    tx.chainId = 1;
    const returnData = await provider.call(tx);
    expect(returnData).to.equal(expectedRevertReason);
  });
});