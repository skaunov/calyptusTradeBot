require("dotenv").config();
import {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as phoenixSdk from "@ellipsis-labs/phoenix-sdk";

export const execute = async () => {
    const REFRESH_FREQ_MS = 2000;
    const MAX_ITERATIONS = 1000;
    const ORDER_LIFETIME_IN_SECONDS = 7;
    
    const EDGE = 0.5;
    let counter = 0;

    if (!process.env.PRIVATE_KEY) {
        throw new Error("Missing PRIVATE_KEY in your .env file");
    }

    let privateKeyArray;
    try {privateKeyArray = JSON.parse(process.env.PRIVATE_KEY);}
    catch (error) {
        throw new Error("Error parsing PRIVATE_KEY. Please make sure it is a stringified array");
    }

    let traderKeypair = Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));

    const marketPubkey  = new PublicKey( "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg");
    const connection = new Connection("https://api.devnet.solana.com");

    const client = await phoenixSdk.Client.create(connection);

    const marketState = client.marketStates.get(marketPubkey.toString());
    const marketData = marketState?.data;
    if (!marketData) {
        throw new Error("Market data not found");
    }

    const setupNewMakerIxs = await phoenixSdk.getMakerSetupInstructionsForMarket(
        connection,    marketState, traderKeypair.publicKey
    );
    if (setupNewMakerIxs.length !== 0) {
        const setup = new Transaction().add(...setupNewMakerIxs);
        const setupTxId = await sendAndConfirmTransaction(connection, setup, [traderKeypair], {
            skipPreflight: true, commitment: "confirmed",
        });
        console.log(`Setup Tx Link: https://beta.solscan.io/tx/${setupTxId}`);
    }
    else {   console.log("No setup required. Continuing...");}

    do {
        const cancelAll = client.createCancelAllOrdersInstruction(
            marketPubkey.toString(), traderKeypair.publicKey,
        );
        try {
            const cancelTx = new Transaction().add(cancelAll);
            const cancelTxId = await sendAndConfirmTransaction(connection, cancelTx, [traderKeypair], {
                skipPreflight: true, commitment: "confirmed",
            });
            console.log("Cancel tx link: https://beta.solscan.io/tx/" + cancelTxId);
        }
        catch (err) {     console.log("Error: ", err);    }
        
        try {
            const response = await fetch(
                "https://api.coinbase.com/v2/prices/SOL-USD/spot"
            );
            const data/* : any */ = await response.json();
            
            if (!response.ok)
              throw new Error(`HTTP error! Status: ${response.status}`);
            if (!data.data || !data.data.amount)
              throw new Error("Invalid response structure");
            
            const price = data.data.amount;

            let bidPrice = price - EDGE;
            let askPrice = price + EDGE;
    
            console.log(`$SOL price: ${price}`);
            console.log(`Placing bid (buy) order at: ${bidPrice}`);
            console.log(`Placing ask (sell) order at: ${askPrice}`);

            const currentTiime = Math.floor(Date.now() / 1000);

            const bidOrderTemplate: phoenixSdk.LimitOrderTemplate = {
                side: phoenixSdk.Side.Bid,
                priceAsFloat: bidPrice,
                sizeInBaseUnits: 1,
                selfTradeBehavior: phoenixSdk.SelfTradeBehavior.Abort,
                clientOrderId: 1,
                useOnlyDepositedFunds: true,
                lastValidSlot: undefined,
                lastValidUnixTimestampInSeconds: currentTiime + ORDER_LIFETIME_IN_SECONDS,
            };
            const bidLimitOrderIx = client.getLimitOrderInstructionfromTemplate(
                marketPubkey.toBase58(), traderKeypair.publicKey, bidOrderTemplate
            );

            const askOrderTemplate: phoenixSdk.LimitOrderTemplate = {
                side: phoenixSdk.Side.Ask,
                priceAsFloat: askPrice,
                sizeInBaseUnits: 1,
                selfTradeBehavior: phoenixSdk.SelfTradeBehavior.Abort,
                clientOrderId: 1,
                useOnlyDepositedFunds: true,
                lastValidSlot: undefined,
                lastValidUnixTimestampInSeconds: currentTiime + ORDER_LIFETIME_IN_SECONDS,
            };
            const askLimitOrderIx = client.getLimitOrderInstructionfromTemplate(
                marketPubkey.toBase58(), traderKeypair.publicKey, askOrderTemplate
            );

            // it's not *that* big problem that last orders will live for 7 seconds instead of 2
            let ixs: TransactionInstruction[] = [bidLimitOrderIx, askLimitOrderIx];

            try {
                const placeQuotesTx = new Transaction().add(...ixs);
                const placeQuotesTxId = await sendAndConfirmTransaction(connection, placeQuotesTx, [traderKeypair], {
                    skipPreflight: true, commitment: "confirmed",
                });
                console.log(
                    "Place quotes",
                    bidPrice.toFixed(marketState.getPriceDecimalPlaces()),
                    "@",
                    askPrice.toFixed(marketState.getPriceDecimalPlaces()),
                );
                console.log(`Tx link: https://beta.solscan.io/tx/${placeQuotesTxId}`);
            }
            catch (err) {
                console.log("Error: ", err);
                continue;
            }

            counter++;
            await delay(REFRESH_FREQ_MS);
        } catch (error) {
            console.error(error);
        }
    } while (counter < MAX_ITERATIONS);

    const withdrawParams: phoenixSdk.WithdrawParams = {
        quoteLotsToWithdraw: null, baseLotsToWithdraw: null
    };
    
    try {
        const withdrawTx = new Transaction().add(client.createCancelAllOrdersInstruction(
            marketPubkey.toString(), traderKeypair.publicKey,
        )).add(client.createWithdrawFundsInstruction(
            {withdrawFundsParams: withdrawParams}, marketPubkey.toString(), traderKeypair.publicKey,
        ));
        const withdrawTxId = await sendAndConfirmTransaction(connection, withdrawTx, [traderKeypair], {
            skipPreflight: true, commitment: "confirmed",
        });
        console.log("Cancel tx link: https://beta.solscan.io/tx/" + withdrawTx);
    }
    catch (err) {     console.log("Error: ", err);    }
};
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
execute();