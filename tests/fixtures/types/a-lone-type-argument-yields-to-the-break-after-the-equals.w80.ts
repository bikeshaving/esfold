type MappedEventListenerOrEventListenerObject<T extends string> = MappedEventListener<T> | {handleEvent: MappedEventListener<T>};
