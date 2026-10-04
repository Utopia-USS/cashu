# Moja strategia: pasywny portfel ETF

> Szablon startowy. Zastąp pytania i przykłady własnymi słowami. Ten plik to część opisowa strategii:
> Aplikacja przekazuje go Claude'owi jako kontekst przy interpretacji sygnałów i w raportach. Liczby
> (wagi, progi, wpłaty) wpisujesz w `strategy.yaml`, a tutaj wyjaśniasz, dlaczego są takie.

## Cel

Po co inwestuję i co ma się stać z tymi pieniędzmi?

- Na co odkładam (emerytura, mieszkanie, poduszka na przyszłość, niezależność finansowa)?
- Ile mniej więcej chcę mieć i na kiedy?
- Skąd będę wiedzieć, że strategia działa?

Przykład: *Buduję długoterminowy majątek na emeryturę. Nie próbuję pokonać rynku, chcę dostać jego
średni wynik niskim kosztem i bez codziennego pilnowania.*

## Horyzont

- Przez ile lat nie będę potrzebować tych pieniędzy (zgodnie z `horizon_years` w YAML)?
- Czy w tym czasie przewiduję duże wydatki, które wymusiłyby sprzedaż?
- Jak zmieni się podział akcje / obligacje, gdy cel będzie bliżej?

## Tolerancja ryzyka

- Jak zareaguję, gdy portfel spadnie o 20% lub 30%? Czy będę spać spokojnie?
- Jaki najgorszy rok jestem w stanie przetrwać bez sprzedawania?
- Dlaczego wybrałam taki podział: ok. 70% akcje (globalny ETF), 25% obligacje, 5% gotówka?
- Czy mam poduszkę finansową poza tym portfelem (żeby nie sprzedawać w złym momencie)?

## Zasady wejścia i wyjścia

Wejście (kupowanie):

- Wpłacam stałą kwotę co miesiąc (`contributions` w YAML) i od razu kupuję zgodnie z wagami docelowymi.
- Nowe wpłaty kieruję do tej części portfela, która jest najbardziej poniżej celu.
- Gdy gotówka czeka, a globalne akcje są poniżej celu (reguła `invest_idle_cash`), od razu ją
  inwestuję w globalny ETF.
- Duży spadek rynku (reguła `market_dip`) to przypomnienie, żeby trzymać się planu, a nie sygnał do
  sprzedaży.

Wyjście (sprzedawanie, rebalansowanie):

- Rebalansuję, gdy któraś część odjedzie od celu poza pasmo z `allocation.rebalance` (reguła
  `rebalance_check`), najwyżej kilka razy w roku.
- Sprzedaję tylko wtedy, gdy zbliża się cel albo zmieniam strategię, a nie z powodu nastroju na rynku.
- Jakie konto wybieram do wypłaty (IKE / IKZE / zwykłe) i dlaczego?

## Czego unikam

- Pojedynczych spółek i "gorących" tematów, o których wszyscy mówią.
- Kupowania i sprzedawania pod wpływem wiadomości lub emocji.
- Funduszy z wysokimi opłatami, produktów z dźwignią, kryptowalut.
- Sprawdzania wyceny codziennie. Aplikacja da znać, gdy coś naprawdę wymaga uwagi.

## Notatki i zmiany

Zapisuj tu datę i powód każdej zmiany strategii, np. *2026-10: zmiana podziału 80/20 na 70/30, bo...*
