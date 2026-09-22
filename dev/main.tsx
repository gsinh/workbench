import {
  Box,
  Button,
  ChakraProvider,
  Container,
  Flex,
  Heading,
  Link,
  List,
  Text,
} from "@chakra-ui/react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Diarize } from "../src/diarization";
import { StirShaken } from "../src/stir-shaken";
import { VoiceLatency } from "../src/voice-latency";
import { system } from "./system";
import { apply, initial } from "./color-mode";

const WRITE_UP = "https://gsinh.com/lab/voice-agent-latency-budget";

/**
 * Development harness. Not part of the published package — it exists so the
 * experiments can be run on their own, without a host application.
 *
 * It carries enough context to make the demo legible to someone who has just
 * cloned the repo; the long-form argument lives with the write-up rather than
 * being duplicated here, where it would drift.
 */
function App() {
  const [mode, setMode] = useState<"light" | "dark">("light");

  useEffect(() => {
    const next = initial();
    setMode(next);
    apply(next);
  }, []);

  return (
    <ChakraProvider value={system}>
      <Container maxW="4xl" py="10" fontSize="sm">
        <Flex justify="flex-end" mb="2">
          <Button
            size="2xs"
            variant="outline"
            onClick={() => {
              const next = mode === "dark" ? "light" : "dark";
              setMode(next);
              apply(next);
            }}
          >
            {mode === "dark" ? "Light" : "Dark"}
          </Button>
        </Flex>
        <Heading as="h1" size="lg">
          Voice agent latency budget
        </Heading>
        <Text mt="3" color="fg.muted" maxW="2xl" lineHeight="tall">
          Ask how fast a voice agent is and you will be told about the model —
          time to first token, because that is the figure providers publish. It
          is rarely the largest line in the budget. What a caller actually
          experiences is the gap between their last word and the agent&rsquo;s
          first, and that gap is seven costs in series, only one of which is the
          model thinking.
        </Text>

        <VoiceLatency />

        <Box mt="16" pt="10" borderTopWidth="1px" borderColor="border">
          <Heading as="h1" size="lg">
            STIR/SHAKEN inspector
          </Heading>
          <Text mt="3" color="fg.muted" maxW="2xl" lineHeight="tall">
            Every signed call carries a PASSporT: a JWT asserting who the
            carrier thinks is calling. Paste one and this takes it apart —
            decoded, checked against the specifications line by line, and its
            signature verified in the browser.
          </Text>
          <StirShaken />
        </Box>

        <Box mt="16" pt="10" borderTopWidth="1px" borderColor="border">
          <Heading as="h1" size="lg">
            Speaker diarization from first principles
          </Heading>
          <Text mt="3" color="fg.muted" maxW="2xl" lineHeight="tall">
            Who spoke when, worked out with no model and no network — framing,
            MFCCs, statistics pooling, clustering. The sample conversation is
            synthesised in the page from a known script, so the result can be
            scored rather than admired.
          </Text>
          <Diarize />
        </Box>

        <Box mt="16" pt="10" borderTopWidth="1px" borderColor="border">
          <Heading as="h2" size="sm">
            Read more
          </Heading>
          <Text mt="2" color="fg.muted" lineHeight="tall">
            The full write-up — why the stages are in series, why endpointing
            drifts long, the chunk stage nobody draws, why the playout buffer is
            charged twice, and what the model leaves out — is at{" "}
            <Link href={WRITE_UP} target="_blank" rel="noopener noreferrer">
              gsinh.com/lab/voice-agent-latency-budget
            </Link>
            .
          </Text>

          <Heading as="h2" size="sm" mt="8">
            What is real here
          </Heading>
          <Text mt="2" color="fg.muted" lineHeight="tall">
            Three of the seven stages are measured on your machine rather than
            estimated:
          </Text>
          <List.Root mt="3" ps="5" gap="1.5" color="fg.muted">
            <List.Item>
              <Text as="span" color="fg">
                Audio stack
              </Text>{" "}
              — capture and sink buffering, straight from{" "}
              <Text as="code" fontFamily="mono" fontSize="xs">
                AudioContext
              </Text>
              .
            </List.Item>
            <List.Item>
              <Text as="span" color="fg">
                TTS first audio
              </Text>{" "}
              — measured from{" "}
              <Text as="code" fontFamily="mono" fontSize="xs">
                speechSynthesis.speak()
              </Text>{" "}
              to the utterance&rsquo;s start event.
            </List.Item>
            <List.Item>
              <Text as="span" color="fg">
                Endpointing
              </Text>{" "}
              — a live energy VAD running the slider against your real
              microphone. Audio never leaves the page.
            </List.Item>
          </List.Root>
          <Text mt="3" color="fg.muted" lineHeight="tall">
            The other four — uplink, ASR, the model, the downlink — need
            infrastructure a static page cannot reach, so they are sliders with
            documented defaults rather than measurements dressed up as facts.
          </Text>

          <Heading as="h2" size="sm" mt="8">
            Using the arithmetic on its own
          </Heading>
          <Text mt="2" color="fg.muted" lineHeight="tall">
            <Text as="code" fontFamily="mono" fontSize="xs">
              src/voice-latency/model.ts
            </Text>{" "}
            is plain TypeScript with no React and no browser APIs. If you want
            one file out of this repo, it is that one.
          </Text>
        </Box>
      </Container>
    </ChakraProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
