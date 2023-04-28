import dotenv from 'dotenv';
dotenv.config();
import { ethers } from 'ethers';
import { createProof, ANTEUP_ADDRESS, decodeProof } from './src/build-proof';

async function initProvider() {
  if (!process.env.MAINNET_RPC) {
    throw new Error('MAINNET_RPC env var not set');
  }
  if(process.env.MAINNET_RPC.startsWith('wss')) {
    return new ethers.providers.WebSocketProvider(process.env.MAINNET_RPC);
  }

  return new ethers.providers.JsonRpcProvider(process.env.MAINNET_RPC);

}

async function run(txHash: string) {

  
  const anteUpABI = require('./src/anteup-abi.json');
  const provider = await initProvider();
  const anteUpContract = new ethers.Contract(ANTEUP_ADDRESS, anteUpABI, provider);
  

  const proof = await createProof(provider, txHash);
  console.log(`Transaction: ${txHash} proof:
${proof}
`);
  try {
    
    const isValidProof = await anteUpContract.verifyAnteUpTransaction(proof);
    console.log(`Proof is valid: ${isValidProof}`);

  }catch(e) {
    console.log(`Proof is invalid`);
  }
}

run(process.argv[2])
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });