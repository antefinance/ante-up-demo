import {ethers} from 'ethers';
import { Common } from '@ethereumjs/common';
import { MerkleTree } from 'merkletreejs';
import { rlp } from 'ethereumjs-util';
import { Block } from '@ethereumjs/block';
import { ParamType } from 'ethers/lib/utils';

export const ANTEUP_ADDRESS = '0x2ae392dc9Af24CA5FD8E5D5912190f0fC4Ad9D99';

export const providerSendWithRetry = async (provider: ethers.providers.JsonRpcProvider, method: string, params: any[], maxRetries: number = 10) => {
  let tries = 0;
  while (tries < maxRetries) {
    try {
      const response = await provider.send(method, params);
      return response;;
      
    } catch (e) {
      tries += 1;
    }
  }
  throw new Error(`Failed to fetch ${method} from provider`);
}

export async function getBlockInfo(provider: ethers.providers.JsonRpcProvider, blockHash: string) {
  const blockInfo = await provider.send('eth_getBlockByHash', [blockHash, false]);
  let hardfork = 'merge';
  if (blockInfo.number < 12244000) {
    hardfork = 'muirGlacier';
  } else if (blockInfo.number < 12965000) {
    hardfork = 'berlin';
  } else if (blockInfo.number < 13773000) {
    hardfork = 'london';
  } else if (blockInfo.number < 15050000) {
    hardfork = 'arrowGlacier';
  } else if (blockInfo.number < 15537394) {
    hardfork = 'grayGlacier';
  } else if (blockInfo.number < 17034870) {
    hardfork = 'merge';
  } else {
    hardfork = 'shanghai';
  }

  const common = new Common({ chain: 'mainnet', hardfork });
  const block = await Block.fromEthersProvider(provider, blockHash, {
    common
  });
  const header = block.header;
  const raw = header.raw();

  if (!header._common.isActivatedEIP(4895)) {
    if (blockInfo.withdrawalsRoot) {
      raw.push(Buffer.from(blockInfo.withdrawalsRoot.slice(2), 'hex'));
    }
  }
  const headerRlpEncoded = rlp.encode(raw);
  await block.validateTransactionsTrie();
  return {
    header: `0x${headerRlpEncoded.toString('hex')}`,
    trie: block.txTrie,
    block: block,
  }

}

export async function getBlockBasicInfo(
  blockNumber: number,
  provider: ethers.providers.JsonRpcProvider
) {
  const block = await provider.getBlock(blockNumber);
  return {
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp,
  };
}

export async function parallelLoadBlocksRange(provider: ethers.providers.JsonRpcProvider, startBlock: number, endBlock: number) {
  const promises = [];
  for (let i = startBlock; i < endBlock; i++) {
    promises.push(getBlockBasicInfo(i, provider));
  }
  return (await Promise.all(promises)).reduce((acc: Record<number, any>, block) => {
    acc[block.number] = block;
    return acc;
  }, {});
}

export async function getAxiomWitness(
  provider: ethers.providers.JsonRpcProvider,
  targetBlockHash: string,
): Promise<any> {
  console.log(`Constructing Axiom witness for block ${targetBlockHash}...`);
  const currentBlock = await provider.getBlock('latest');
  const targetBlock = await provider.getBlock(targetBlockHash);
  const blocksHashesLeafs: string[] = [];
  const firstOldestBlockDivisibleBy1024 = targetBlock.number - (targetBlock.number % 1024);
  const prevBlockBeforeFirstOldestBlockDivisibleBy1024 = await getBlockBasicInfo(firstOldestBlockDivisibleBy1024 - 1, provider);
  const prevHash = prevBlockBeforeFirstOldestBlockDivisibleBy1024.hash;
  let numFinal = 0;
  const lastBlock = Math.min(firstOldestBlockDivisibleBy1024 + 1024, currentBlock.number);
  const blocksRange = await parallelLoadBlocksRange(provider, firstOldestBlockDivisibleBy1024, lastBlock);
  for (let i = firstOldestBlockDivisibleBy1024; i < lastBlock; i++) {
    const block = blocksRange[i]; //await getBlockBasicInfo(i, provider);
    blocksHashesLeafs.push(block.hash);
  }
  numFinal = 1024 - blocksHashesLeafs.length;
  if (numFinal == 0) {
    numFinal = 1024;
  }
  for (let i = blocksHashesLeafs.length; i < 1024; i++) {
    blocksHashesLeafs.push(ethers.constants.HashZero);
  }
  const merkleTree = new MerkleTree(blocksHashesLeafs, ethers.utils.keccak256);
  const merkleProof = merkleTree.getHexProof(Buffer.from(targetBlock.hash.slice(2), 'hex'));
  return {
    blockNumber: targetBlock.number,
    claimedBlockHash: targetBlock.hash,
    prevHash: prevHash,
    numFinal: numFinal,
    merkleProof: merkleProof,
  }
}



export async function createProof(provider: ethers.providers.JsonRpcProvider, txHash: string ): Promise<string> {
  const tx = await providerSendWithRetry(provider, 'eth_getTransactionByHash', [txHash]);
  console.log(`Transaction ${txHash} found in block ${tx.blockNumber} at index ${tx.transactionIndex}`);
  if (!tx) {
    throw new Error(`Transaction ${txHash} not found`);
  }
  console.log(`Creating transaction proof for ${txHash}...`);
  const blockInfo = await getBlockInfo(provider, tx.blockHash);
  const { trie } = blockInfo;
  const transactionKey = rlp.encode(tx.transactionIndex);
  const txProof = await trie.createProof(transactionKey);
  const axiomWitness = await getAxiomWitness(provider, tx.blockHash);
  const txProofEncoded = ethers.utils.defaultAbiCoder.encode(["bytes[]"], [txProof.map((p) => `0x${p.toString('hex')}`)]);
  const txInclusionProof = ethers.utils.defaultAbiCoder.encode(
    [
      ParamType.fromString("tuple(uint256 blockNumber, bytes32 claimedBlockHash, bytes32 prevHash, uint256 numFinal, bytes32[10] merkleProof)"),
      "bytes", // header
      "bytes", // encoded proof
      "bytes", // transaction key
      "bytes32" // transaction hash
    ], [
      axiomWitness,
      blockInfo.header,
      txProofEncoded,
      `0x${transactionKey.toString('hex')}`,
      txHash
    ]);
  return txInclusionProof;
}

export async function decodeProof(proof: string) {
  const decoded = ethers.utils.defaultAbiCoder.decode(
    [
      ParamType.fromString("tuple(uint256 blockNumber, bytes32 claimedBlockHash, bytes32 prevHash, uint256 numFinal, bytes32[10] merkleProof)"),
      "bytes",
      "bytes",
      "bytes",
      "bytes32"
    ], proof);
  return decoded;
}
