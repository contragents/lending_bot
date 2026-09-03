import axios from "axios";

// Внутренние интерфейсы для строгой типизации ответов сервера
interface LendingSuccessResponse {
	result?: never;
	"0": string;
	raw_data: {
		withdraw?: Record<string, number>;
		repay?: Record<string, number>;
		supply?: Record<string, number>;
		borrow?: Record<string, number>;

		deloop?: Record<string, number>;
		loop?: Record<string, number>;
	};
}

interface LendingErrorResponse {
	result: "error";
	message: string;
}

type LendingApiResponse = LendingSuccessResponse | LendingErrorResponse;

// Описываем возвращаемый тип функции согласно вашему требованию
export interface LendingLeverageResult {
	deloop?: Record<string, number>;
	loop?: Record<string, number>;
}

/**
 * Получает инструкцию из lending пула и извлекает параметры поддержки плеча (loop/deloop).
 *
 * @param lendingId Идентификатор lending пула
 * @returns Объект с параметрами loop/deloop или пустой объект {} в случае ошибки
 */
export async function fetchLendingInstruction(lendingId: number): Promise<LendingLeverageResult> {
	const url = `https://invest.legal/lending/recommend?lending_id=${lendingId}`;

	try {
		const response = await axios.get<LendingApiResponse>(url);
		const data = response.data;

		// 1. Обработка внутренней ошибки бизнес-логики API
		if (data.result === "error") {
			console.error(`[Ошибка API]: Не удалось получить инструкцию. Сообщение: "${data.message}"`);
			return {};
		}

		// 2. Извлекаем данные, если они существуют
		const rawData = data.raw_data;
		if (!rawData) {
			return {};
		}

		const result: LendingLeverageResult = {};

		// Наполняем возвращаемый объект только теми полями, которые пришли от сервера
		if (rawData.deloop) result.deloop = rawData.deloop;
		if (rawData.loop) result.loop = rawData.loop;

		return result;

	} catch (error) {
		// 3. Обработка сетевых ошибок (404, 500, таймауты)
		if (axios.isAxiosError(error)) {
			console.error(`[Сетевая ошибка]: Запрос к API отклонен: ${error.message}`);
		} else {
			console.error("[Непредвиденная ошибка]:", error);
		}

		return {};
	}
}
