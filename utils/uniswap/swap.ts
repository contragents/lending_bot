import { CONFIG, type SupportedToken } from "../../config.js";

import { ethers } from "ethers";
import { wallet } from "../loadWallet.js";

/**
 * Меняем 'underlyingSymbol' на нативный ETH
 *
 * @param underlyingSymbol Токен для обмена
 * @param amountHuman Количество токенов
 * @param quote {number} стоимость 'underlyingSymbol' в Эфирах
 */
export async function swapToEth(
	underlyingSymbol: SupportedToken,
	amountHuman: number,
	quote: number
): Promise<boolean> {
// 1. Настройка подключения и кошелька
	//const RPC_URL = "https://optimism.io";
	//const PRIVATE_KEY = "ВАШ_ПРИВАТНЫЙ_КЛЮЧ";
	//const provider = new ethers.JsonRpcProvider(RPC_URL);
	//const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// 2. Адреса из вашей транзакции
	const SWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";// "0x8B844f885672f333Bc0042cB669255f93a4C1E6b"; // Контракт из лога
	// const OP_TOKEN_ADDRESS = "0x4200000000000000000000000000000000000042";     // Токен OP
	// const WETH_TOKEN_ADDRESS = "0x4200000000000000000000000000000000000006";   // Токен WETH

	// todo если не сработает стандартный ABI - попробовать этот
	//const ERC20_ABI = ["function approve(address spender, uint256 amount) public returns (bool)"];

	async function main() {
		const amountIn = ethers.parseUnits(amountHuman + '', 18);       // 546 OP
		const amountOutMin = ethers.parseUnits(quote * amountHuman * 0.995 + '', 18);   // Минимальный ETH (защита от проскальзывания)
		const deadline = Math.floor(Date.now() / 1000) + 60 * 10; // Срок действия 10 минут

		const routerContract = new ethers.Contract(SWAP_ROUTER_ADDRESS, CONFIG.ABI.UNISWAP_ROUTER, wallet);
		const opContract = new ethers.Contract(CONFIG.NETWORKS.OPT.TOKENS[underlyingSymbol], CONFIG.ABI.ERC20_BALANCE_ABI, wallet);

		// Шаг 1: Одобряем роутеру трату токенов OP
		console.log("1. Отправка Approve...");
		const approveTx = await opContract.approve(SWAP_ROUTER_ADDRESS, amountIn);
		await approveTx.wait();
		console.log("Аппрув успешно подтвержден!");

		// Шаг 2: Кодируем путь обмена OP -> Пул 0.3% -> WETH
		// 3000 bps в Uniswap соответствует пулу с комиссией 0.3%
		const path = ethers.solidityPacked(
			["address", "uint24", "address"],
			[CONFIG.NETWORKS.OPT.TOKENS[underlyingSymbol], 3000, CONFIG.NETWORKS.OPT.TOKENS.WETH]
		);

		// Шаг 3: Кодируем внутренние вызовы для Multicall
		console.log("2. Подготовка вызовов внутри пакета (Multicall)...");

		// Инструкция А: Своп OP на WETH.
		// ВНИМАНИЕ: Получателем (recipient) ставим адрес самого Роутера (адрес 2), чтобы он мог тут же развернуть WETH
		const exactInputData = routerContract.interface.encodeFunctionData("exactInput", [{
			path: path,
			recipient: SWAP_ROUTER_ADDRESS, // WETH временно идет на контракт роутера
			deadline: deadline,
			amountIn: amountIn,
			amountOutMinimum: amountOutMin
		}]);

		// Инструкция Б: Роутер забирает полученный WETH, разворачивает в ETH и отправляет на ваш кошелек
		const unwrapWETH9Data = routerContract.interface.encodeFunctionData("unwrapWETH9", [
			amountOutMin,   // Минимальное количество на выход
			wallet.address  // Конечный получатель нативного ETH (ваш кошелек)
		]);

		// Шаг 4: Упаковываем обе инструкции в один массив и отправляем одну транзакцию
		console.log("3. Отправка транзакции обмена...");
		const tx = await routerContract.multicall([exactInputData, unwrapWETH9Data], {
			gasLimit: 350000 // Лимит с запасом, Optimism спишет копейки по факту
		});

		console.log(`Транзакция отправлена! Хэш: ${tx.hash}`);
		const receipt = await tx.wait();
		console.log(`Успешно исполнено в блоке: ${receipt.blockNumber}`);

		return true
	}

	const res = await main().catch((error) => {
		console.error("Ошибка при выполнении скрипта:", error);

		return false;
	});

	return res;
}
