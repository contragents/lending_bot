import { ethers } from 'ethers';
import * as fs from 'fs';

async function createKeystore() {
    const privateKey = ""; // Вставьте реальный ключ
    const password = ""; // Придумайте пароль

    const wallet = new ethers.Wallet(privateKey);

    console.log("Шифруем кошелек... Это займет несколько секунд.");

    // encrypt() генерирует JSON-строку по стандарту Ethereum
    const encryptedJson = await wallet.encrypt(password);
console.log (encryptedJson);
//    fs.writeFileSync('wallet.json', encryptedJson);
    console.log("Готово! Файл wallet.json создан. Теперь удалите приватный ключ из этого скрипта.");
}

createKeystore();
