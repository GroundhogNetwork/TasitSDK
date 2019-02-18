import { expect, assert } from "chai";

import { Account, Action } from "./TasitSdk";
const { ERC20, ERC721, Marketplace, ConfigLoader } = Action;
const { Mana } = ERC20;
const { Estate, Land } = ERC721;
const { Decentraland: DecentralandMarketplace } = Marketplace;
import config from "./config/default";

import { ropsten as ropstenAddresses } from "../../tasit-contracts/decentraland/addresses";
const {
  MarketplaceProxy: MARKETPLACE_ADDRESS,
  LANDProxy: LAND_ADDRESS,
  MANAToken: MANA_ADDRESS,
  EstateProxy: ESTATE_ADDRESS,
} = ropstenAddresses;

import {
  createSnapshot,
  revertFromSnapshot,
  confirmBalances,
  gasParams,
  setupWallets,
  addressesAreEqual,
  bigNumberify,
  etherFaucet,
  ropstenManaFaucet,
  constants,
  ProviderFactory,
  DecentralandUtils,
} from "./testHelpers/helpers";

const { ONE, TEN, BILLION } = constants;

const ROPSTEN_NETWORK_ID = 3;

describe("Decentraland tasit app test cases (ropsten)", () => {
  let ownerWallet;
  let ephemeralWallet;
  let manaContract;
  let landContract;
  let estateContract;
  let marketplaceContract;
  let landForSale;
  let estateForSale;
  let snapshotId;
  let provider;

  before("", async () => {
    ConfigLoader.setConfig(config);

    provider = ProviderFactory.getProvider();

    const network = await provider.getNetwork();
    const { chainId } = network;
    expect(chainId, "The target network isn't ropsten.").to.equal(
      ROPSTEN_NETWORK_ID
    );

    manaContract = new Mana(MANA_ADDRESS);
    landContract = new Land(LAND_ADDRESS);
    estateContract = new Estate(ESTATE_ADDRESS);
    marketplaceContract = new DecentralandMarketplace(MARKETPLACE_ADDRESS);

    const decentralandUtils = new DecentralandUtils();
    const { getOpenSellOrders } = decentralandUtils;

    const fromBlock = 0;
    const openSellOrders = await getOpenSellOrders(fromBlock);

    // Note: The exact amount of land isn't predictable since we are forking from the latest block
    expect(openSellOrders).to.not.be.empty;

    // Pick a land and an estate open sell orders
    for (let sellOrder of openSellOrders) {
      const { values: order } = sellOrder;
      const { nftAddress, expiresAt } = order;

      if (landForSale && estateForSale) break;

      const isLand = addressesAreEqual(nftAddress, LAND_ADDRESS);
      const isEstate = addressesAreEqual(nftAddress, ESTATE_ADDRESS);
      const expired = Number(expiresAt) < Date.now();

      // All lands are expired
      if (isLand) landForSale = order;
      if (isEstate && !expired) estateForSale = order;

      if (!isLand && !isEstate)
        expect(
          false,
          "All land for sale should be a land or an estate NFT"
        ).to.equal(true);
    }

    expect(estateForSale).to.not.be.an("undefined");
    expect(landForSale).to.not.be.an("undefined");
  });

  beforeEach(
    "buyer approve marketplace contract to transfer tokens on their behalf",
    async () => {
      snapshotId = await createSnapshot(provider);

      ({ ownerWallet, ephemeralWallet } = setupWallets());
      expect(ownerWallet.address).to.have.lengthOf(42);
      expect(ephemeralWallet.address).to.have.lengthOf(42);

      await etherFaucet(provider, ownerWallet, ephemeralWallet, ONE);

      await confirmBalances(manaContract, [ephemeralWallet.address], [0]);
      await ropstenManaFaucet(provider, ownerWallet, ephemeralWallet, BILLION);
      await confirmBalances(manaContract, [ephemeralWallet.address], [BILLION]);

      manaContract.setWallet(ephemeralWallet);
      const approvalAction = manaContract.approve(
        MARKETPLACE_ADDRESS,
        BILLION,
        gasParams
      );
      await approvalAction.waitForNonceToUpdate();

      const allowance = await manaContract.allowance(
        ephemeralWallet.address,
        MARKETPLACE_ADDRESS
      );

      expect(`${allowance}`).to.equal(`${BILLION}`);
    }
  );

  afterEach("", async () => {
    await revertFromSnapshot(provider, snapshotId);
  });

  it("should get land for sale info (without wallet)", async () => {
    const { assetId } = landForSale;

    const metadataPromise = landContract.tokenMetadata(assetId);
    const coordsPromise = landContract.decodeTokenId(assetId);
    const [metadata, coords] = await Promise.all([
      metadataPromise,
      coordsPromise,
    ]);

    // Note: Metadata could be an empty string
    expect(metadata).to.not.be.null;

    const [x, y] = coords;
    expect(coords).to.not.include(null);
    expect(x.toNumber()).to.be.a("number");
    expect(y.toNumber()).to.be.a("number");
  });

  it("should get estate for sale info (without wallet)", async () => {
    const { assetId } = estateForSale;

    const metadataPromise = estateContract.getMetadata(assetId);
    const sizePromise = estateContract.getEstateSize(assetId);
    const [metadata, size] = await Promise.all([metadataPromise, sizePromise]);

    // Note: Metadata could be an empty string
    expect(metadata).to.not.be.null;

    expect(size.toNumber()).to.be.a("number");
    expect(size.toNumber()).to.be.at.least(0);
  });

  // Note: This test case isn't working. The transaction is been revert and the reason isn't know yet
  it.skip("should buy an estate", async () => {
    const {
      assetId,
      nftAddress,
      seller,
      priceInWei,
      expiresAt,
    } = estateForSale;

    const { address: ephemeralAddress } = ephemeralWallet;

    const expiresTime = Number(expiresAt);
    expect(Date.now()).to.be.below(expiresTime);

    const priceInWeiBN = bigNumberify(priceInWei);

    // Buyer (ephemeral wallet) has enough MANA
    const manaBalance = await manaContract.balanceOf(ephemeralAddress);
    const manaBalanceBN = bigNumberify(manaBalance);
    expect(manaBalanceBN.gt(priceInWeiBN)).to.be.true;

    // Marketplace is approved to transfer Estate asset owned by the seller
    const approvedForAsset = await estateContract.getApproved(assetId);
    const approvedForAll = await estateContract.isApprovedForAll(
      seller,
      MARKETPLACE_ADDRESS
    );
    const approved =
      addressesAreEqual(approvedForAsset, MARKETPLACE_ADDRESS) ||
      approvedForAll;
    expect(approved).to.be.true;

    await confirmBalances(estateContract, [ephemeralWallet.address], [0]);

    const fingerprint = await estateContract.getFingerprint(assetId.toString());
    marketplaceContract.setWallet(ephemeralWallet);
    const executeOrderAction = marketplaceContract.safeExecuteOrder(
      nftAddress,
      `${assetId}`,
      `${priceInWei}`,
      `${fingerprint}`,
      gasParams
    );

    await executeOrderAction.waitForNonceToUpdate();

    await confirmBalances(estateContract, [ephemeralWallet.address], [1]);
  });

  // All land sell orders are expired
  it.skip("should buy a land", async () => {});
});