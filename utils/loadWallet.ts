import {ethers} from "ethers";
import {BASE_CHAIN, getEnv, HL_CHAIN, OPT_CHAIN, type ChainType} from "../config.js";
import readline from "readline/promises";
import {HDNodeWallet, Wallet} from "ethers";

export type Wallets = Record<ChainType, Wallet | HDNodeWallet | undefined>;

async function loadWallet(providers: ReadonlyMap<ChainType, ethers.Provider>): Promise<Wallets> {
	const keystoreJson = getEnv('ENCRYPTED_KEY');
	let password = getEnv('KEY_PASSWORD');
	if (!password || password === '0') {
		// Запрашиваем пароль в консоли (безопаснее, чем хранить в .env)
		const rl = readline.createInterface({input: process.stdin, output: process.stdout});
		password = await rl.question('Введите пароль от кошелька: ');
		rl.close();
	}

	const baseProvider = providers.get(BASE_CHAIN);
	const optimismProvider = providers.get(OPT_CHAIN);
	if (!baseProvider || !optimismProvider) {
		throw new Error("Providers for Base and Optimism must be configured before wallet initialization");
	}

	let decryptedWallet: Wallet | HDNodeWallet;
	try {
		console.log("Расшифровка...");
		decryptedWallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
	} catch (e) {
		console.log("Неверный пароль!");

		return {
			[BASE_CHAIN]: undefined,
			[OPT_CHAIN]: undefined,
			[HL_CHAIN]: undefined,
		};
	}

	return {
		[BASE_CHAIN]: decryptedWallet.connect(baseProvider),
		[OPT_CHAIN]: decryptedWallet.connect(optimismProvider),
		[HL_CHAIN]: undefined,
	};
}

export let wallets: Wallets = {
	[BASE_CHAIN]: undefined,
	[OPT_CHAIN]: undefined,
	[HL_CHAIN]: undefined,
};

export async function initializeWallet(providers: ReadonlyMap<ChainType, ethers.Provider>): Promise<void> {
	wallets = await loadWallet(providers);
}