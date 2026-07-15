import { describe, expect, it } from "vitest";
import { intToWordsPt, normalizeNumbersPt } from "../fittings/seed/jarvis-os/ui/speakable-numbers";

describe("intToWordsPt", () => {
  it("handles the basics", () => {
    expect(intToWordsPt(0)).toBe("zero");
    expect(intToWordsPt(1)).toBe("um");
    expect(intToWordsPt(16)).toBe("dezasseis"); // PT-PT, not "dezesseis"
    expect(intToWordsPt(21)).toBe("vinte e um");
    expect(intToWordsPt(100)).toBe("cem");
    expect(intToWordsPt(101)).toBe("cento e um");
    expect(intToWordsPt(999)).toBe("novecentos e noventa e nove");
  });

  it("handles thousands with correct 'e' joins", () => {
    expect(intToWordsPt(1000)).toBe("mil");
    expect(intToWordsPt(1100)).toBe("mil e cem");
    expect(intToWordsPt(1005)).toBe("mil e cinco");
    expect(intToWordsPt(1234)).toBe("mil duzentos e trinta e quatro");
    expect(intToWordsPt(100000)).toBe("cem mil");
    expect(intToWordsPt(100005)).toBe("cem mil e cinco");
  });

  it("handles millions and PT-PT thousand-millions", () => {
    expect(intToWordsPt(1_000_000)).toBe("um milhão");
    expect(intToWordsPt(2_500_000)).toBe("dois milhões quinhentos mil");
    expect(intToWordsPt(1_000_000_000)).toBe("mil milhões");
  });
});

describe("normalizeNumbersPt", () => {
  it("fixes the reported case: €100.000 read as 'cem, zero, zero, zero'", () => {
    expect(normalizeNumbersPt("custa €100.000 em Lisboa")).toBe("custa cem mil euros em Lisboa");
  });

  it("handles symbol before and after, with and without space", () => {
    expect(normalizeNumbersPt("€ 1.500")).toBe("mil e quinhentos euros");
    expect(normalizeNumbersPt("1.500€")).toBe("mil e quinhentos euros");
    expect(normalizeNumbersPt("100.000 euros")).toBe("cem mil euros");
    expect(normalizeNumbersPt("1 euro")).toBe("um euro");
  });

  it("speaks cents", () => {
    expect(normalizeNumbersPt("€19,99")).toBe("dezanove euros e noventa e nove cêntimos");
    expect(normalizeNumbersPt("€2,50")).toBe("dois euros e cinquenta cêntimos");
    expect(normalizeNumbersPt("€5,00")).toBe("cinco euros");
  });

  it("handles other currencies", () => {
    expect(normalizeNumbersPt("$1.000")).toBe("mil dólares");
    expect(normalizeNumbersPt("2.000 libras")).toBe("duas mil libras".replace("duas", "dois")); // masc. default
  });

  it("converts bare separator-grouped numbers", () => {
    expect(normalizeNumbersPt("são 1.234.567 pessoas")).toBe(
      "são um milhão duzentos e trinta e quatro mil quinhentos e sessenta e sete pessoas",
    );
    expect(normalizeNumbersPt("cerca de 12.000 casos")).toBe("cerca de doze mil casos");
  });

  it("speaks decimal commas", () => {
    expect(normalizeNumbersPt("subiu 2,5 milhões")).toBe("subiu dois vírgula cinco milhões");
  });

  it("spells out percent", () => {
    expect(normalizeNumbersPt("caiu 12%")).toBe("caiu 12 por cento");
    expect(normalizeNumbersPt("subiu 2,5%")).toBe("subiu dois vírgula cinco por cento");
  });

  it("fixes the reported case: 23°C read as 'graus C'", () => {
    expect(normalizeNumbersPt("Lisboa 23°C")).toBe("Lisboa 23 graus Celsius");
    expect(normalizeNumbersPt("Lisboa 23 °C, céu limpo")).toBe("Lisboa 23 graus Celsius, céu limpo");
    expect(normalizeNumbersPt("1°C")).toBe("1 grau Celsius");
    expect(normalizeNumbersPt("-5°C")).toBe("menos 5 graus Celsius");
    expect(normalizeNumbersPt("75°F")).toBe("75 graus Fahrenheit");
    expect(normalizeNumbersPt("máxima de 23°")).toBe("máxima de 23 graus");
  });

  it("never mistakes ordinals for degrees", () => {
    expect(normalizeNumbersPt("ficou em 1º lugar")).toBe("ficou em 1º lugar");
    expect(normalizeNumbersPt("no 23º aniversário")).toBe("no 23º aniversário");
  });

  it("expands distance, weight and volume units", () => {
    expect(normalizeNumbersPt("ficam a 10 km")).toBe("ficam a 10 quilómetros");
    expect(normalizeNumbersPt("1 km a pé")).toBe("1 quilómetro a pé");
    expect(normalizeNumbersPt("120 km/h")).toBe("120 quilómetros por hora");
    expect(normalizeNumbersPt("mede 1,80 m")).toBe("mede um vírgula oito zero metros");
    expect(normalizeNumbersPt("500 m de distância")).toBe("500 metros de distância");
    expect(normalizeNumbersPt("2,5 kg de arroz")).toBe("dois vírgula cinco quilos de arroz");
    expect(normalizeNumbersPt("750 ml de água")).toBe("750 mililitros de água");
    expect(normalizeNumbersPt("2 l de leite")).toBe("2 litros de leite");
    expect(normalizeNumbersPt("um T2 de 85 m²")).toBe("um T2 de 85 metros quadrados");
  });

  it("expands clock times and durations", () => {
    expect(normalizeNumbersPt("abre às 22h30")).toBe("abre às 22 horas e 30");
    expect(normalizeNumbersPt("das 22h às 2h")).toBe("das 22 horas às 2 horas");
    expect(normalizeNumbersPt("demora 45 min")).toBe("demora 45 minutos");
    expect(normalizeNumbersPt("1h de viagem")).toBe("1 hora de viagem");
  });

  it("expands data sizes but never the 5G network", () => {
    expect(normalizeNumbersPt("500 GB de disco")).toBe("500 gigabytes de disco");
    expect(normalizeNumbersPt("rede 5G em Lisboa")).toBe("rede 5G em Lisboa");
    expect(normalizeNumbersPt("5 g de sal")).toBe("5 gramas de sal");
  });

  it("leaves plain numbers, versions and years alone", () => {
    expect(normalizeNumbersPt("em 2026 há 100 vagas")).toBe("em 2026 há 100 vagas");
    expect(normalizeNumbersPt("versão 0.1.0 do node 4.8")).toBe("versão 0.1.0 do node 4.8");
    expect(normalizeNumbersPt("às 19,30 não é dinheiro")).toBe("às dezanove vírgula três zero não é dinheiro");
  });
});
