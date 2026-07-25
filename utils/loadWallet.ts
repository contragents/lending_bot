import {ethers} from "ethers";
import {getEnv, provider} from "../config.js";
import readline from "readline/promises";
import {HDNodeWallet, Wallet} from "ethers";

async function loadWallet(provider: ethers.Provider) {
	const keystoreJson = getEnv('ENCRYPTED_KEY');
	let password = getEnv('KEY_PASSWORD');
	if (!password || password === '0') {
		// Запрашиваем пароль в консоли (безопаснее, чем хранить в .env)
		const rl = readline.createInterface({input: process.stdin, output: process.stdout});
		password = await rl.question('Введите пароль от кошелька: ');
		rl.close();
	}

	try {
		console.log("Расшифровка...");
		// Восстанавливаем кошелек
		const wallet = await ethers.Wallet.fromEncryptedJson(keystoreJson!, password);

		return wallet.connect(provider);
	} catch (e) {
		console.log("Неверный пароль!");

		return;
	}
}

export const wallet: Wallet | HDNodeWallet | undefined = await loadWallet(provider);