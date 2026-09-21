import { ChakraProvider, Container, Heading, Text } from "@chakra-ui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VoiceLatency } from "../src/voice-latency";
import { system } from "./system";

/**
 * Development harness. Not part of the published package — it exists so the
 * experiments can be run on their own, without a host application.
 */
function App() {
  return (
    <ChakraProvider value={system}>
      <Container maxW="4xl" py="10" fontSize="sm">
        <Heading as="h1" size="lg">
          Voice agent latency budget
        </Heading>
        <Text mt="2" color="fg.muted">
          Where the second between a question and an answer actually goes.
        </Text>
        <VoiceLatency />
      </Container>
    </ChakraProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
